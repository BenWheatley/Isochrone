"""Configuration loading and orchestration for multi-region data artifacts."""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, TextIO, cast

from isochrone_pipeline.osm_json_survey import iter_overpass_elements

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_LOCATIONS_FILE = REPO_ROOT / "data_pipeline" / "regions.json"
DEFAULT_INPUT_DIR = REPO_ROOT / "data_pipeline" / "input"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "data_pipeline" / "output"
DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter"
DEFAULT_MAX_TIME_SECONDS = 600
DEFAULT_BOUNDARY_RESOLUTION = 25.0
DEFAULT_BOUNDARY_UNITS = "meters"
ROUTING_QUERY_SCRIPT = REPO_ROOT / "docs" / "overpass_routing_query.sh"
BOUNDARY_QUERY_SCRIPT = REPO_ROOT / "docs" / "overpass_boundary_query.sh"

BoundaryUnits = Literal["meters", "degrees"]
BoundaryBuilder = Callable[..., dict[str, Any]]
GraphBuilder = Callable[..., dict[str, Any]]
QueryRenderer = Callable[..., str]
OverpassFetcher = Callable[..., None]
_SUPPORTED_TRANSIT_ARCHIVE_FORMATS: frozenset[str] = frozenset({"files", "zip"})
DEFAULT_FETCH_COMPONENTS: frozenset[str] = frozenset({"routing", "boundary"})
DEFAULT_BUILD_COMPONENTS: frozenset[str] = frozenset({"graph", "boundary"})
# transfers.txt is optional in the GTFS spec and some feeds omit it; every
# other table here is load-bearing for the CSA scan.
REQUIRED_GTFS_TRANSIT_FILE_NAMES: frozenset[str] = frozenset(
    {"agency", "calendar", "calendar_dates", "routes", "stops", "trips", "stop_times"}
)

GTFS_TRANSIT_FILE_NAMES: tuple[str, ...] = (
    "agency",
    "calendar",
    "calendar_dates",
    "routes",
    "stops",
    "transfers",
    "trips",
    "stop_times",
)


class RegionDataHelpFormatter(
    argparse.ArgumentDefaultsHelpFormatter,
    argparse.RawDescriptionHelpFormatter,
):
    """Formatter that preserves example blocks and includes defaults."""


@dataclass(frozen=True)
class TransitAttributionSpec:
    """Who to credit, and under what, wherever the data surfaces."""

    operator: str
    licence_name: str
    url: str


@dataclass(frozen=True)
class TransitFeedSpec:
    base_url: str
    licence: str
    # How the publisher serves the feed. "files" is one CSV per GTFS table
    # (the Berlin mirror); "zip" is the single archive most agencies publish.
    archive_format: str = "files"
    attribution: TransitAttributionSpec | None = None


@dataclass(frozen=True)
class RegionSpec:
    id: str
    name: str
    graph_file_name: str
    boundary_file_name: str
    location_relation: str
    subdivision_admin_level: str
    subdivision_discovery_modes: tuple[str, ...]
    epsg: int
    graph_binary_file_name: str
    graph_summary_file_name: str
    boundary_resolution: float
    boundary_units: BoundaryUnits
    localized_names: dict[str, str] | None = None
    coastal: bool = False
    coast_source: str | None = None
    transit_feed: TransitFeedSpec | None = None

    @property
    def routing_input_file_name(self) -> str:
        return f"{self.id}-routing.osm.json"

    @property
    def boundary_input_file_name(self) -> str:
        return f"{self.id}-district-boundaries.osm.json"

    @property
    def transit_input_dir_name(self) -> str:
        return f"{self.id}-transit-gtfs"


def load_region_specs(locations_file: Path) -> tuple[RegionSpec, ...]:
    payload = json.loads(locations_file.read_text(encoding="utf-8"))
    locations = payload.get("locations")
    if not isinstance(locations, list) or not locations:
        raise ValueError("locations file must contain a non-empty 'locations' array")

    seen_ids: set[str] = set()
    region_specs: list[RegionSpec] = []

    for index, entry in enumerate(locations):
        if not isinstance(entry, dict):
            raise ValueError(f"locations[{index}] must be an object")

        region_id = _require_non_empty_string(entry.get("id"), f"locations[{index}].id")
        if region_id in seen_ids:
            raise ValueError(f"duplicate location id: {region_id}")
        seen_ids.add(region_id)

        name = _require_non_empty_string(entry.get("name"), f"locations[{index}].name")
        localized_names = _normalize_localized_names(
            entry.get("localizedNames"),
            field_name=f"locations[{index}].localizedNames",
        )
        graph_file_name = _require_non_empty_string(
            entry.get("graphFileName"),
            f"locations[{index}].graphFileName",
        )
        if not graph_file_name.endswith(".gz"):
            raise ValueError(f"locations[{index}].graphFileName must end with .gz")

        boundary_file_name = _require_non_empty_string(
            entry.get("boundaryFileName"),
            f"locations[{index}].boundaryFileName",
        )
        location_relation = _require_non_empty_string(
            entry.get("locationRelation"),
            f"locations[{index}].locationRelation",
        )
        subdivision_admin_level = _require_non_empty_string(
            entry.get("subdivisionAdminLevel"),
            f"locations[{index}].subdivisionAdminLevel",
        )
        subdivision_discovery_modes = _normalize_subdivision_discovery_modes(
            entry.get("subdivisionDiscoveryModes", ["area", "subarea"]),
            field_name=f"locations[{index}].subdivisionDiscoveryModes",
        )
        epsg = _require_int(entry.get("epsg"), f"locations[{index}].epsg")
        graph_binary_file_name = entry.get("graphBinaryFileName")
        if graph_binary_file_name is None:
            graph_binary_file_name = graph_file_name.removesuffix(".gz")
        graph_binary_file_name = _require_non_empty_string(
            graph_binary_file_name,
            f"locations[{index}].graphBinaryFileName",
        )
        graph_summary_file_name = _require_non_empty_string(
            entry.get("graphSummaryFileName", f"{region_id}-graph-summary.json"),
            f"locations[{index}].graphSummaryFileName",
        )
        boundary_resolution = _require_float(
            entry.get("boundaryResolution", DEFAULT_BOUNDARY_RESOLUTION),
            f"locations[{index}].boundaryResolution",
        )
        boundary_units = _require_non_empty_string(
            entry.get("boundaryUnits", DEFAULT_BOUNDARY_UNITS),
            f"locations[{index}].boundaryUnits",
        )
        if boundary_units not in {"meters", "degrees"}:
            raise ValueError(f"locations[{index}].boundaryUnits must be 'meters' or 'degrees'")
        normalized_boundary_units = cast(BoundaryUnits, boundary_units)
        coastal = _normalize_optional_bool(
            entry.get("coastal", False),
            field_name=f"locations[{index}].coastal",
        )
        coast_source = entry.get("coastSource")
        if coast_source is not None:
            coast_source = _require_non_empty_string(
                coast_source,
                f"locations[{index}].coastSource",
            )
        transit_feed = _normalize_transit_feed(
            entry.get("transitFeed"),
            field_name=f"locations[{index}].transitFeed",
        )

        region_specs.append(
            RegionSpec(
                id=region_id,
                name=name,
                graph_file_name=graph_file_name,
                boundary_file_name=boundary_file_name,
                location_relation=location_relation,
                subdivision_admin_level=subdivision_admin_level,
                subdivision_discovery_modes=subdivision_discovery_modes,
                epsg=epsg,
                graph_binary_file_name=graph_binary_file_name,
                graph_summary_file_name=graph_summary_file_name,
                boundary_resolution=boundary_resolution,
                boundary_units=normalized_boundary_units,
                localized_names=localized_names,
                coastal=coastal,
                coast_source=coast_source,
                transit_feed=transit_feed,
            )
        )

    return tuple(region_specs)


def build_location_manifest(
    region_specs: Sequence[RegionSpec],
    *,
    transit_date_ranges: dict[str, dict[str, str]] | None = None,
) -> dict[str, Any]:
    transit_date_ranges = transit_date_ranges or {}
    return {
        "locations": [
            _build_manifest_location_entry(spec, transit_date_ranges.get(spec.id))
            for spec in region_specs
        ]
    }


def _build_manifest_location_entry(
    spec: RegionSpec,
    transit_date_range: dict[str, str] | None = None,
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": spec.id,
        "name": spec.name,
        "graphFileName": spec.graph_file_name,
        "boundaryFileName": spec.boundary_file_name,
    }
    if spec.localized_names:
        entry["localizedNames"] = dict(spec.localized_names)
    if spec.transit_feed is not None and transit_date_range is not None:
        entry["transitDateRange"] = dict(transit_date_range)
    # Attribution travels with the region rather than living in the UI's locale
    # files: which operator to credit is a property of the region's feed, not
    # of the language the page happens to be in.
    if spec.transit_feed is not None and spec.transit_feed.attribution is not None:
        attribution = spec.transit_feed.attribution
        entry["transitAttribution"] = {
            "operator": attribution.operator,
            "licenceName": attribution.licence_name,
            "url": attribution.url,
        }
    return entry


def select_region_specs(
    region_specs: Sequence[RegionSpec],
    only_ids: Sequence[str] | None,
) -> list[RegionSpec]:
    if not only_ids:
        return list(region_specs)

    wanted_ids = {
        part.strip() for raw_value in only_ids for part in raw_value.split(",") if part.strip()
    }
    if not wanted_ids:
        return list(region_specs)

    selected = [spec for spec in region_specs if spec.id in wanted_ids]
    missing_ids = wanted_ids.difference({spec.id for spec in selected})
    if missing_ids:
        missing_list = ", ".join(sorted(missing_ids))
        raise ValueError(f"unknown region ids requested via --only: {missing_list}")
    return selected


def run_fetch_pipeline(
    region_specs: Sequence[RegionSpec],
    *,
    input_dir: Path,
    overpass_url: str,
    max_time_seconds: int,
    routing_query_script: Path = ROUTING_QUERY_SCRIPT,
    boundary_query_script: Path = BOUNDARY_QUERY_SCRIPT,
    render_query_fn: QueryRenderer | None = None,
    fetch_overpass_json_fn: OverpassFetcher | None = None,
    fetch_gtfs_transit_files_fn: Callable[..., None] | None = None,
    fetch_components: frozenset[str] = DEFAULT_FETCH_COMPONENTS,
    stderr: TextIO | None = None,
) -> None:
    stderr = stderr or sys.stderr
    input_dir.mkdir(parents=True, exist_ok=True)
    render_query_fn = render_query_fn or render_query
    fetch_overpass_json_fn = fetch_overpass_json_fn or fetch_overpass_json
    fetch_gtfs_transit_files_fn = fetch_gtfs_transit_files_fn or fetch_gtfs_transit_files

    for spec in region_specs:
        if "routing" in fetch_components:
            _log(stderr, f"Fetching routing extract for {spec.name}")
            routing_output_path = input_dir / spec.routing_input_file_name
            routing_query = render_query_fn(
                routing_query_script,
                "--location-label",
                spec.name,
                "--location-relation",
                spec.location_relation,
            )
            _log_rendered_query(
                stderr,
                label=f"routing query for {spec.name}",
                query_text=routing_query,
                output_path=routing_output_path,
                overpass_url=overpass_url,
                max_time_seconds=max_time_seconds,
            )
            fetch_overpass_json_fn(
                query_text=routing_query,
                output_path=routing_output_path,
                overpass_url=overpass_url,
                max_time_seconds=max_time_seconds,
                request_label=f"routing extract for {spec.name}",
            )

        if "boundary" in fetch_components:
            _log(stderr, f"Fetching boundary extract for {spec.name}")
            boundary_output_path = input_dir / spec.boundary_input_file_name
            boundary_query = render_query_fn(
                boundary_query_script,
                "--location-label",
                spec.name,
                "--location-relation",
                spec.location_relation,
                "--subdivision-admin-level",
                spec.subdivision_admin_level,
                "--subdivision-discovery-modes",
                ",".join(spec.subdivision_discovery_modes),
            )
            _log_rendered_query(
                stderr,
                label=f"boundary query for {spec.name}",
                query_text=boundary_query,
                output_path=boundary_output_path,
                overpass_url=overpass_url,
                max_time_seconds=max_time_seconds,
            )
            fetch_overpass_json_fn(
                query_text=boundary_query,
                output_path=boundary_output_path,
                overpass_url=overpass_url,
                max_time_seconds=max_time_seconds,
                request_label=f"boundary extract for {spec.name}",
            )

        if "transit" in fetch_components and spec.transit_feed is not None:
            _log(stderr, f"Fetching GTFS transit feed for {spec.name}")
            transit_dir = input_dir / spec.transit_input_dir_name
            fetch_gtfs_transit_files_fn(
                base_url=spec.transit_feed.base_url,
                output_dir=transit_dir,
                max_time_seconds=max_time_seconds,
                archive_format=spec.transit_feed.archive_format,
                stderr=stderr,
            )


def fetch_gtfs_transit_files(
    *,
    base_url: str,
    output_dir: Path,
    max_time_seconds: int,
    file_names: tuple[str, ...] = GTFS_TRANSIT_FILE_NAMES,
    archive_format: str = "files",
    stderr: TextIO | None = None,
) -> None:
    """Download a GTFS feed into ``output_dir`` as one ``<table>.txt`` per table.

    Publishers serve GTFS two ways. A few expose the tables individually (the
    Berlin mirror serves ``<table>.csv``); most publish a single zip, which is
    what the spec itself describes. Both land in the same layout on disk so the
    build does not care which it was.
    """
    if archive_format not in _SUPPORTED_TRANSIT_ARCHIVE_FORMATS:
        raise ValueError(
            f"archive_format must be one of {sorted(_SUPPORTED_TRANSIT_ARCHIVE_FORMATS)}, "
            f"got {archive_format!r}"
        )
    if archive_format == "zip":
        _fetch_gtfs_transit_zip(
            base_url=base_url,
            output_dir=output_dir,
            max_time_seconds=max_time_seconds,
            file_names=file_names,
            stderr=stderr,
        )
        return

    stderr = stderr or sys.stderr
    output_dir.mkdir(parents=True, exist_ok=True)

    for file_name in file_names:
        output_path = output_dir / f"{file_name}.txt"
        source_url = f"{base_url}/{file_name}.csv"
        _log(stderr, f"  downloading {source_url} -> {output_path}")

        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=output_dir,
            prefix=f"{file_name}-",
            suffix=".tmp",
            delete=False,
        ) as temp_output:
            temp_output_path = Path(temp_output.name)

        try:
            result = subprocess.run(
                [
                    "curl",
                    "--show-error",
                    "--fail",
                    "--max-time",
                    str(max_time_seconds),
                    "-L",
                    source_url,
                    "-o",
                    str(temp_output_path),
                ],
                check=False,
                text=True,
                capture_output=True,
            )
            if result.returncode != 0:
                raise RuntimeError(
                    f"GTFS transit file download failed for {source_url}\n"
                    f"curl_exit_code={result.returncode}\n"
                    f"curl_stderr={result.stderr.strip()}"
                )
            temp_output_path.replace(output_path)
        finally:
            temp_output_path.unlink(missing_ok=True)


def extract_gtfs_tables_from_archive(
    *,
    archive_path: Path,
    output_dir: Path,
    file_names: tuple[str, ...] = GTFS_TRANSIT_FILE_NAMES,
    source_label: str | None = None,
    stderr: TextIO | None = None,
) -> tuple[str, ...]:
    """Unpack the GTFS tables we use out of ``archive_path``.

    Split out from the download so the interesting behaviour - which tables are
    required, and what a feed missing them should say - is testable without
    reaching the network.
    """
    stderr = stderr or sys.stderr
    label = source_label or str(archive_path)
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        with zipfile.ZipFile(archive_path) as archive:
            # Some publishers nest the tables in a folder inside the archive,
            # so match on the base name rather than the full member path.
            members = {Path(name).name: name for name in archive.namelist()}
            # Feeds legitimately omit optional tables (transfers.txt is the
            # usual one), so a missing member is only fatal when the build
            # actually needs it. Report the whole set at once, so one run tells
            # you what a feed has rather than one table per attempt.
            missing = sorted(
                file_name
                for file_name in file_names
                if f"{file_name}.txt" not in members
                and file_name in REQUIRED_GTFS_TRANSIT_FILE_NAMES
            )
            if missing:
                raise RuntimeError(
                    f"GTFS archive at {label} is missing required tables: "
                    f"{', '.join(missing)}\n"
                    f"archive contains: {', '.join(sorted(members))}"
                )

            extracted: list[str] = []
            for file_name in file_names:
                member = members.get(f"{file_name}.txt")
                if member is None:
                    _log(stderr, f"    {file_name}.txt absent (optional)")
                    continue
                output_path = output_dir / f"{file_name}.txt"
                with archive.open(member) as source, output_path.open("wb") as target:
                    shutil.copyfileobj(source, target)
                _log(stderr, f"    {file_name}.txt -> {output_path}")
                extracted.append(file_name)
            return tuple(extracted)
    except zipfile.BadZipFile as error:
        raise RuntimeError(f"GTFS archive at {label} is not a valid zip file: {error}") from error


def _fetch_gtfs_transit_zip(
    *,
    base_url: str,
    output_dir: Path,
    max_time_seconds: int,
    file_names: tuple[str, ...],
    stderr: TextIO | None = None,
) -> None:
    stderr = stderr or sys.stderr
    output_dir.mkdir(parents=True, exist_ok=True)
    _log(stderr, f"  downloading {base_url} -> {output_dir}")

    with tempfile.TemporaryDirectory(prefix="gtfs-zip-") as scratch_dir:
        archive_path = Path(scratch_dir) / "gtfs.zip"
        result = subprocess.run(
            [
                "curl",
                "--show-error",
                "--fail",
                "--max-time",
                str(max_time_seconds),
                "-L",
                base_url,
                "-o",
                str(archive_path),
            ],
            check=False,
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"GTFS transit archive download failed for {base_url}\n"
                f"curl_exit_code={result.returncode}\n"
                f"curl_stderr={result.stderr.strip()}"
            )

        extract_gtfs_tables_from_archive(
            archive_path=archive_path,
            output_dir=output_dir,
            file_names=file_names,
            source_label=base_url,
            stderr=stderr,
        )


def run_build_pipeline(
    region_specs: Sequence[RegionSpec],
    *,
    input_dir: Path,
    output_dir: Path,
    build_components: frozenset[str] = DEFAULT_BUILD_COMPONENTS,
    simplify_boundaries: BoundaryBuilder | None = None,
    export_graph_binary: GraphBuilder | None = None,
    stderr: TextIO | None = None,
) -> dict[str, Any]:
    stderr = stderr or sys.stderr
    output_dir.mkdir(parents=True, exist_ok=True)

    if simplify_boundaries is None or export_graph_binary is None:
        from isochrone_pipeline.artifacts import (
            write_graph_binary_artifacts,
            write_simplified_boundary_canvas,
        )

        simplify_boundaries = simplify_boundaries or write_simplified_boundary_canvas
        export_graph_binary = export_graph_binary or write_graph_binary_artifacts

    transit_date_ranges: dict[str, dict[str, str]] = {}
    for spec in region_specs:
        routing_input_path = input_dir / spec.routing_input_file_name
        boundary_input_path = input_dir / spec.boundary_input_file_name
        if "boundary" in build_components:
            if not boundary_input_path.is_file():
                raise FileNotFoundError(f"boundary input not found: {boundary_input_path}")
            boundary_output_path = output_dir / spec.boundary_file_name
            _log(stderr, f"Building boundary canvas JSON for {spec.name}")
            coastal_kwargs: dict[str, Any] = {}
            if spec.coastal:
                coastal_kwargs["include_coast"] = True
                if spec.coast_source is not None:
                    coastal_kwargs["coast_source"] = spec.coast_source
            simplify_boundaries(
                input_path=boundary_input_path,
                output_path=boundary_output_path,
                resolution=spec.boundary_resolution,
                units=spec.boundary_units,
                epsg=spec.epsg,
                admin_level=spec.subdivision_admin_level,
                **coastal_kwargs,
            )

        if "graph" in build_components:
            if not routing_input_path.is_file():
                raise FileNotFoundError(f"routing input not found: {routing_input_path}")
            graph_binary_path = output_dir / spec.graph_binary_file_name
            graph_summary_path = output_dir / spec.graph_summary_file_name
            _log(stderr, f"Building routing graph binary for {spec.name}")
            transit_kwargs: dict[str, Any] = {}
            if "transit" in build_components and spec.transit_feed is not None:
                transit_input_dir = input_dir / spec.transit_input_dir_name
                if not transit_input_dir.is_dir():
                    raise FileNotFoundError(f"transit input not found: {transit_input_dir}")
                transit_kwargs["transit_feed_dir"] = transit_input_dir
            graph_summary = export_graph_binary(
                input_path=routing_input_path,
                binary_output=graph_binary_path,
                summary_output=graph_summary_path,
                epsg=spec.epsg,
                **transit_kwargs,
            )
            date_range = graph_summary.get("transit", {}).get("date_range")
            if date_range is not None:
                transit_date_ranges[spec.id] = date_range

            gz_output_path = output_dir / spec.graph_file_name
            _log(stderr, f"Gzipping routing graph for {spec.name}")
            gzip_file(graph_binary_path, gz_output_path)

    return build_location_manifest(region_specs, transit_date_ranges=transit_date_ranges)


def render_query(query_script: Path, *args: str) -> str:
    bash_path = shutil.which("bash")
    if bash_path is None:
        raise RuntimeError("bash is required to render query scripts")

    result = subprocess.run(
        [bash_path, str(query_script), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"query rendering failed: {query_script}")
    return result.stdout


def fetch_overpass_json(
    *,
    query_text: str,
    output_path: Path,
    overpass_url: str,
    max_time_seconds: int,
    stderr: TextIO | None = None,
    request_label: str | None = None,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if stderr is not None:
        _log_rendered_query(
            stderr,
            label=request_label or f"Overpass request for {output_path.name}",
            query_text=query_text,
            output_path=output_path,
            overpass_url=overpass_url,
            max_time_seconds=max_time_seconds,
        )

    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        prefix="overpass-query-",
        suffix=".ql",
        delete=False,
    ) as temp_query:
        temp_query.write(query_text)
        temp_query_path = Path(temp_query.name)
    with tempfile.NamedTemporaryFile(
        mode="wb",
        prefix="overpass-response-",
        suffix=".tmp",
        delete=False,
    ) as temp_response:
        temp_response_path = Path(temp_response.name)
    with tempfile.NamedTemporaryFile(
        mode="wb",
        prefix="overpass-headers-",
        suffix=".tmp",
        delete=False,
    ) as temp_headers:
        temp_headers_path = Path(temp_headers.name)

    try:
        result = subprocess.run(
            [
                "curl",
                "--show-error",
                "--max-time",
                str(max_time_seconds),
                "--dump-header",
                str(temp_headers_path),
                "--data-urlencode",
                f"data@{temp_query_path}",
                overpass_url,
                "-o",
                str(temp_response_path),
                "--write-out",
                "%{http_code}",
            ],
            check=False,
            text=True,
            capture_output=True,
        )
        http_status = _parse_curl_http_status(result.stdout)
        if result.returncode != 0 or http_status >= 400:
            output_path.unlink(missing_ok=True)
            debug_bundle = _write_failed_overpass_debug_bundle(
                output_path=output_path,
                query_text=query_text,
                curl_stdout=result.stdout,
                curl_stderr=result.stderr,
                response_body_path=temp_response_path,
                response_headers_path=temp_headers_path,
            )
            raise RuntimeError(
                _format_overpass_failure_message(
                    request_label=request_label or output_path.name,
                    output_path=output_path,
                    overpass_url=overpass_url,
                    max_time_seconds=max_time_seconds,
                    curl_exit_code=result.returncode,
                    http_status=http_status,
                    debug_bundle=debug_bundle,
                )
            )
        response_validation = _validate_overpass_response_body(temp_response_path)
        if response_validation is not None:
            output_path.unlink(missing_ok=True)
            debug_bundle = _write_failed_overpass_debug_bundle(
                output_path=output_path,
                query_text=query_text,
                curl_stdout=result.stdout,
                curl_stderr=result.stderr,
                response_body_path=temp_response_path,
                response_headers_path=temp_headers_path,
            )
            raise RuntimeError(
                _format_overpass_failure_message(
                    request_label=request_label or output_path.name,
                    output_path=output_path,
                    overpass_url=overpass_url,
                    max_time_seconds=max_time_seconds,
                    curl_exit_code=result.returncode,
                    http_status=http_status,
                    debug_bundle=debug_bundle,
                    response_validation=response_validation,
                )
            )
        temp_response_path.replace(output_path)
        _remove_failed_overpass_debug_bundle(output_path)
    finally:
        temp_query_path.unlink(missing_ok=True)
        temp_response_path.unlink(missing_ok=True)
        temp_headers_path.unlink(missing_ok=True)


def gzip_file(input_path: Path, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with input_path.open("rb") as source, gzip.open(output_path, "wb") as target:
        shutil.copyfileobj(source, target)


def _log_rendered_query(
    stderr: TextIO,
    *,
    label: str,
    query_text: str,
    output_path: Path,
    overpass_url: str,
    max_time_seconds: int,
) -> None:
    _log(stderr, f"Rendered {label}")
    _log(stderr, f"Overpass URL: {overpass_url}")
    _log(stderr, f"Output path: {output_path}")
    _log(stderr, f"Timeout seconds: {max_time_seconds}")
    _log(stderr, f"Query bytes: {len(query_text.encode('utf-8'))}")
    _log(stderr, f"--- begin query: {label} ---")
    stderr.write(query_text)
    if not query_text.endswith("\n"):
        stderr.write("\n")
    _log(stderr, f"--- end query: {label} ---")


def _write_failed_overpass_debug_bundle(
    *,
    output_path: Path,
    query_text: str,
    curl_stdout: str,
    curl_stderr: str,
    response_body_path: Path,
    response_headers_path: Path,
) -> dict[str, Path]:
    query_path = output_path.with_name(f"{output_path.name}.failed-query.ql")
    stderr_path = output_path.with_name(f"{output_path.name}.failed-curl-stderr.txt")
    response_body_debug_path = output_path.with_name(f"{output_path.name}.failed-response-body.txt")
    response_headers_debug_path = output_path.with_name(
        f"{output_path.name}.failed-response-headers.txt"
    )
    query_path.write_text(query_text, encoding="utf-8")
    stderr_path.write_text(curl_stderr, encoding="utf-8")
    shutil.copyfile(response_body_path, response_body_debug_path)
    shutil.copyfile(response_headers_path, response_headers_debug_path)
    debug_bundle = {
        "query": query_path,
        "stderr": stderr_path,
        "response_body": response_body_debug_path,
        "response_headers": response_headers_debug_path,
    }
    if curl_stdout:
        stdout_path = output_path.with_name(f"{output_path.name}.failed-curl-stdout.txt")
        stdout_path.write_text(curl_stdout, encoding="utf-8")
        debug_bundle["stdout"] = stdout_path
    return debug_bundle


def _remove_failed_overpass_debug_bundle(output_path: Path) -> None:
    for suffix in (
        ".failed-query.ql",
        ".failed-curl-stderr.txt",
        ".failed-curl-stdout.txt",
        ".failed-response-body.txt",
        ".failed-response-headers.txt",
    ):
        output_path.with_name(f"{output_path.name}{suffix}").unlink(missing_ok=True)


def _format_overpass_failure_message(
    *,
    request_label: str,
    output_path: Path,
    overpass_url: str,
    max_time_seconds: int,
    curl_exit_code: int,
    http_status: int,
    debug_bundle: dict[str, Path],
    response_validation: str | None = None,
) -> str:
    message_lines = [
        f"Overpass request failed for {request_label}",
        f"output_path={output_path}",
        f"overpass_url={overpass_url}",
        f"max_time_seconds={max_time_seconds}",
        f"curl_exit_code={curl_exit_code}",
        f"http_status={http_status}",
    ]
    if response_validation is not None:
        message_lines.append(f"response_validation={response_validation}")
    message_lines.extend(
        [
            f"saved_query={debug_bundle['query']}",
            f"saved_curl_stderr={debug_bundle['stderr']}",
            f"saved_response_body={debug_bundle['response_body']}",
            f"saved_response_headers={debug_bundle['response_headers']}",
        ]
    )
    stdout_path = debug_bundle.get("stdout")
    if stdout_path is not None:
        message_lines.append(f"saved_curl_stdout={stdout_path}")
    return "\n".join(message_lines)


def _parse_curl_http_status(stdout_text: str) -> int:
    status_text = stdout_text.strip()
    if not status_text:
        return 0
    try:
        return int(status_text.splitlines()[-1].strip())
    except ValueError:
        return 0


def _validate_overpass_response_body(response_body_path: Path) -> str | None:
    try:
        first_element = next(iter_overpass_elements(response_body_path), None)
    except ValueError as exc:
        return f"invalid_overpass_json: {exc}"

    if first_element is None:
        return "empty_overpass_elements"

    return None


def main(
    argv: Sequence[str] | None = None,
    *,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr

    parser = build_arg_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    region_specs = select_region_specs(
        load_region_specs(args.locations_file),
        args.only,
    )

    fetch_components = DEFAULT_FETCH_COMPONENTS
    build_components = DEFAULT_BUILD_COMPONENTS
    if args.command == "fetch":
        fetch_components = _normalize_fetch_components(args.components)
    elif args.command == "build":
        build_components = _normalize_build_components(args.components)
    elif args.command == "all":
        fetch_components = _normalize_fetch_components(args.fetch_components)
        build_components = _normalize_build_components(args.build_components)

    if args.command in {"fetch", "all"}:
        run_fetch_pipeline(
            region_specs,
            input_dir=args.input_dir,
            overpass_url=args.overpass_url,
            max_time_seconds=args.max_time_seconds,
            fetch_components=fetch_components,
            stderr=stderr,
        )

    if args.command in {"build", "all"}:
        manifest = run_build_pipeline(
            region_specs,
            input_dir=args.input_dir,
            output_dir=args.output_dir,
            build_components=build_components,
            stderr=stderr,
        )
        json.dump(manifest, stdout, indent=2)
        stdout.write("\n")

    return 0


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="region-data.py",
        description=(
            "Fetch and build multi-region OSM-derived artifacts for the web app.\n\n"
            "Region configuration is loaded from data_pipeline/regions.json by default.\n"
            "build and all emit the UI locations manifest JSON to stdout."
        ),
        epilog=(
            "Examples:\n"
            "  ./data_pipeline/region-data.py fetch --only paris\n"
            "  ./data_pipeline/region-data.py fetch --only luxembourg-country --components ways\n"
            "  ./data_pipeline/region-data.py build --only luxembourg-country "
            "--components graph > web/src/data/locations.json\n"
            "  ./data_pipeline/region-data.py all --only paris > web/src/data/locations.json"
        ),
        formatter_class=RegionDataHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    common_parser = argparse.ArgumentParser(add_help=False, formatter_class=RegionDataHelpFormatter)
    common_parser.add_argument(
        "--locations-file",
        type=Path,
        default=DEFAULT_LOCATIONS_FILE,
        help="Path to the region configuration JSON.",
    )
    common_parser.add_argument(
        "--only",
        action="append",
        default=[],
        help=(
            "Limit processing to specific region ids from the locations file "
            "(repeatable or comma-separated)."
        ),
    )
    common_parser.add_argument(
        "--input-dir",
        type=Path,
        default=DEFAULT_INPUT_DIR,
        help="Directory containing raw Overpass JSON inputs.",
    )

    fetch_common_parser = argparse.ArgumentParser(
        add_help=False,
        formatter_class=RegionDataHelpFormatter,
    )
    fetch_common_parser.add_argument(
        "--overpass-url",
        default=DEFAULT_OVERPASS_URL,
        help="Overpass interpreter URL.",
    )
    fetch_common_parser.add_argument(
        "--max-time-seconds",
        type=int,
        default=DEFAULT_MAX_TIME_SECONDS,
        help="Maximum curl transfer time in seconds.",
    )

    fetch_parser = subparsers.add_parser(
        "fetch",
        parents=[common_parser, fetch_common_parser],
        help="Download raw Overpass JSON only.",
        description=(
            "Download raw Overpass JSON into the input directory.\n"
            "Prints the rendered Overpass QL and request metadata to stderr before each fetch."
        ),
        epilog=(
            "Examples:\n"
            "  ./data_pipeline/region-data.py fetch --only paris\n"
            "  ./data_pipeline/region-data.py fetch --only luxembourg-country --components ways\n"
            "  ./data_pipeline/region-data.py fetch --only london --components boundaries"
        ),
        formatter_class=RegionDataHelpFormatter,
    )
    fetch_parser.add_argument(
        "--components",
        default="routing,boundary",
        help=(
            "Comma-separated fetch components. Supported values: "
            "routing, way, ways, boundary, boundaries, transit, gtfs."
        ),
    )

    build_parser = subparsers.add_parser(
        "build",
        parents=[common_parser],
        help="Build boundary canvas JSON, binary graphs, and gzip artifacts from raw inputs.",
        description=(
            "Build artifacts from raw inputs already present in the input directory.\n"
            "Writes the UI locations manifest JSON to stdout."
        ),
        epilog=(
            "Examples:\n"
            "  ./data_pipeline/region-data.py build > web/src/data/locations.json\n"
            "  ./data_pipeline/region-data.py build --only luxembourg-country --components graph\n"
            "  ./data_pipeline/region-data.py build --only rome --components boundary"
        ),
        formatter_class=RegionDataHelpFormatter,
    )
    build_parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory for generated artifact outputs.",
    )
    build_parser.add_argument(
        "--components",
        default="graph,boundary",
        help=(
            "Comma-separated build components. Supported values: "
            "graph, routing, way, ways, boundary, boundaries, transit, gtfs."
        ),
    )

    all_parser = subparsers.add_parser(
        "all",
        parents=[common_parser, fetch_common_parser],
        help="Run fetch plus build, then emit the UI locations manifest JSON to stdout.",
        description=(
            "Fetch raw Overpass JSON, then build artifacts from the downloaded inputs.\n"
            "Writes the UI locations manifest JSON to stdout after a successful build."
        ),
        epilog=(
            "Examples:\n"
            "  ./data_pipeline/region-data.py all > web/src/data/locations.json\n"
            "  ./data_pipeline/region-data.py all --only paris > web/src/data/locations.json\n"
            "  ./data_pipeline/region-data.py all --only luxembourg-country "
            "--fetch-components ways --build-components graph"
        ),
        formatter_class=RegionDataHelpFormatter,
    )
    all_parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory for generated artifact outputs.",
    )
    all_parser.add_argument(
        "--fetch-components",
        default="routing,boundary",
        help=(
            "Comma-separated fetch components. Supported values: "
            "routing, way, ways, boundary, boundaries, transit, gtfs."
        ),
    )
    all_parser.add_argument(
        "--build-components",
        default="graph,boundary",
        help=(
            "Comma-separated build components. Supported values: "
            "graph, routing, way, ways, boundary, boundaries, transit, gtfs."
        ),
    )

    return parser


def _log(stderr: TextIO, message: str) -> None:
    stderr.write(f"{message}\n")


def _require_non_empty_string(value: object, field_name: str) -> str:
    if not isinstance(value, str) or value.strip() == "":
        raise ValueError(f"{field_name} must be a non-empty string")
    return value.strip()


def _normalize_subdivision_discovery_modes(value: object, *, field_name: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{field_name} must be a non-empty array")

    allowed_modes = {"area", "subarea"}
    normalized_modes: list[str] = []
    seen_modes: set[str] = set()
    for index, raw_mode in enumerate(value):
        mode = _require_non_empty_string(raw_mode, f"{field_name}[{index}]")
        if mode not in allowed_modes:
            allowed_list = ", ".join(sorted(allowed_modes))
            raise ValueError(f"{field_name}[{index}] must be one of: {allowed_list}")
        if mode in seen_modes:
            continue
        seen_modes.add(mode)
        normalized_modes.append(mode)

    if not normalized_modes:
        raise ValueError(f"{field_name} must include at least one supported mode")
    return tuple(normalized_modes)


def _normalize_optional_bool(value: object, *, field_name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{field_name} must be a boolean")
    return value


def _normalize_transit_feed(value: object, *, field_name: str) -> TransitFeedSpec | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"{field_name} must be an object when provided")

    base_url = _require_non_empty_string(value.get("baseUrl"), f"{field_name}.baseUrl")
    licence = _require_non_empty_string(value.get("licence"), f"{field_name}.licence")

    archive_format = value.get("archiveFormat", "files")
    if archive_format not in _SUPPORTED_TRANSIT_ARCHIVE_FORMATS:
        raise ValueError(
            f"{field_name}.archiveFormat must be one of "
            f"{sorted(_SUPPORTED_TRANSIT_ARCHIVE_FORMATS)}, got {archive_format!r}"
        )

    return TransitFeedSpec(
        base_url=base_url.rstrip("/"),
        licence=licence,
        archive_format=archive_format,
        attribution=_normalize_transit_attribution(
            value.get("attribution"), field_name=f"{field_name}.attribution"
        ),
    )


def _normalize_transit_attribution(
    value: object, *, field_name: str
) -> TransitAttributionSpec | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"{field_name} must be an object when provided")
    return TransitAttributionSpec(
        operator=_require_non_empty_string(value.get("operator"), f"{field_name}.operator"),
        licence_name=_require_non_empty_string(
            value.get("licenceName"), f"{field_name}.licenceName"
        ),
        url=_require_non_empty_string(value.get("url"), f"{field_name}.url"),
    )


def _normalize_localized_names(value: object, *, field_name: str) -> dict[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"{field_name} must be an object when provided")

    normalized: dict[str, str] = {}
    for raw_locale, raw_name in value.items():
        locale = (
            _require_non_empty_string(
                raw_locale,
                f"{field_name}.<locale>",
            )
            .replace("_", "-")
            .lower()
        )
        name = _require_non_empty_string(raw_name, f"{field_name}[{locale}]")
        normalized[locale] = name

    return normalized or None


def _normalize_fetch_components(value: object) -> frozenset[str]:
    tokens = _parse_component_tokens(value, field_name="components")
    alias_map = {
        "routing": "routing",
        "way": "routing",
        "ways": "routing",
        "boundary": "boundary",
        "boundaries": "boundary",
        "transit": "transit",
        "gtfs": "transit",
    }
    return frozenset(_normalize_component_aliases(tokens, alias_map, field_name="components"))


def _normalize_build_components(value: object) -> frozenset[str]:
    tokens = _parse_component_tokens(value, field_name="components")
    alias_map = {
        "graph": "graph",
        "routing": "graph",
        "way": "graph",
        "ways": "graph",
        "boundary": "boundary",
        "boundaries": "boundary",
        "transit": "transit",
        "gtfs": "transit",
    }
    return frozenset(_normalize_component_aliases(tokens, alias_map, field_name="components"))


def _parse_component_tokens(value: object, *, field_name: str) -> tuple[str, ...]:
    raw_value = _require_non_empty_string(value, field_name)
    tokens = tuple(part.strip().lower() for part in raw_value.split(",") if part.strip())
    if not tokens:
        raise ValueError(f"{field_name} must contain at least one component")
    return tokens


def _normalize_component_aliases(
    tokens: Sequence[str],
    alias_map: dict[str, str],
    *,
    field_name: str,
) -> tuple[str, ...]:
    normalized: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        canonical = alias_map.get(token)
        if canonical is None:
            allowed = ", ".join(sorted(alias_map))
            raise ValueError(
                f"{field_name} contains unsupported component '{token}' (allowed: {allowed})"
            )
        if canonical in seen:
            continue
        seen.add(canonical)
        normalized.append(canonical)
    return tuple(normalized)


def _require_int(value: object, field_name: str) -> int:
    if not isinstance(value, int):
        raise ValueError(f"{field_name} must be an integer")
    return value


def _require_float(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"{field_name} must be a number")
    return float(value)
