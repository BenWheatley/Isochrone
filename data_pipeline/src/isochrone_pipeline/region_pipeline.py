"""Configuration loading and orchestration for multi-region data artifacts."""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, TextIO, cast

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


@dataclass(frozen=True)
class RegionSpec:
    id: str
    name: str
    graph_file_name: str
    boundary_file_name: str
    location_relation: str
    subdivision_admin_level: str
    subdivision_discovery_modes: tuple[str, ...]
    routing_tile_size_degrees: float | None
    epsg: int
    graph_binary_file_name: str
    graph_summary_file_name: str
    boundary_resolution: float
    boundary_units: BoundaryUnits

    @property
    def routing_input_file_name(self) -> str:
        return f"{self.id}-routing.osm.json"

    @property
    def boundary_input_file_name(self) -> str:
        return f"{self.id}-district-boundaries.osm.json"


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
        routing_tile_size_degrees = _optional_positive_float(
            entry.get("routingTileSizeDegrees"),
            f"locations[{index}].routingTileSizeDegrees",
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

        region_specs.append(
            RegionSpec(
                id=region_id,
                name=name,
                graph_file_name=graph_file_name,
                boundary_file_name=boundary_file_name,
                location_relation=location_relation,
                subdivision_admin_level=subdivision_admin_level,
                subdivision_discovery_modes=subdivision_discovery_modes,
                routing_tile_size_degrees=routing_tile_size_degrees,
                epsg=epsg,
                graph_binary_file_name=graph_binary_file_name,
                graph_summary_file_name=graph_summary_file_name,
                boundary_resolution=boundary_resolution,
                boundary_units=normalized_boundary_units,
            )
        )

    return tuple(region_specs)


def build_location_manifest(region_specs: Sequence[RegionSpec]) -> dict[str, Any]:
    return {
        "locations": [
            {
                "id": spec.id,
                "name": spec.name,
                "graphFileName": spec.graph_file_name,
                "boundaryFileName": spec.boundary_file_name,
            }
            for spec in region_specs
        ]
    }


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
    render_query_fn: Callable[..., str] | None = None,
    fetch_overpass_json_fn: Callable[..., None] | None = None,
    stderr: TextIO | None = None,
) -> None:
    stderr = stderr or sys.stderr
    input_dir.mkdir(parents=True, exist_ok=True)
    render_query_fn = render_query_fn or render_query
    fetch_overpass_json_fn = fetch_overpass_json_fn or fetch_overpass_json

    for spec in region_specs:
        if spec.routing_tile_size_degrees is None:
            _log(stderr, f"Fetching routing extract for {spec.name}")
            routing_query = render_query_fn(
                routing_query_script,
                "--location-label",
                spec.name,
                "--location-relation",
                spec.location_relation,
            )
            fetch_overpass_json_fn(
                query_text=routing_query,
                output_path=input_dir / spec.routing_input_file_name,
                overpass_url=overpass_url,
                max_time_seconds=max_time_seconds,
            )
        else:
            fetch_tiled_routing_extract(
                spec=spec,
                input_dir=input_dir,
                overpass_url=overpass_url,
                max_time_seconds=max_time_seconds,
                routing_query_script=routing_query_script,
                render_query_fn=render_query_fn,
                fetch_overpass_json_fn=fetch_overpass_json_fn,
                stderr=stderr,
            )

        _log(stderr, f"Fetching boundary extract for {spec.name}")
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
        fetch_overpass_json_fn(
            query_text=boundary_query,
            output_path=input_dir / spec.boundary_input_file_name,
            overpass_url=overpass_url,
            max_time_seconds=max_time_seconds,
        )


def run_build_pipeline(
    region_specs: Sequence[RegionSpec],
    *,
    input_dir: Path,
    output_dir: Path,
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

    for spec in region_specs:
        routing_input_path = input_dir / spec.routing_input_file_name
        boundary_input_path = input_dir / spec.boundary_input_file_name
        if not routing_input_path.is_file():
            raise FileNotFoundError(f"routing input not found: {routing_input_path}")
        if not boundary_input_path.is_file():
            raise FileNotFoundError(f"boundary input not found: {boundary_input_path}")

        boundary_output_path = output_dir / spec.boundary_file_name
        _log(stderr, f"Building boundary canvas JSON for {spec.name}")
        simplify_boundaries(
            input_path=boundary_input_path,
            output_path=boundary_output_path,
            resolution=spec.boundary_resolution,
            units=spec.boundary_units,
            epsg=spec.epsg,
            admin_level=spec.subdivision_admin_level,
        )

        graph_binary_path = output_dir / spec.graph_binary_file_name
        graph_summary_path = output_dir / spec.graph_summary_file_name
        _log(stderr, f"Building routing graph binary for {spec.name}")
        export_graph_binary(
            input_path=routing_input_path,
            binary_output=graph_binary_path,
            summary_output=graph_summary_path,
            epsg=spec.epsg,
        )

        gz_output_path = output_dir / spec.graph_file_name
        _log(stderr, f"Gzipping routing graph for {spec.name}")
        gzip_file(graph_binary_path, gz_output_path)

    return build_location_manifest(region_specs)


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


def fetch_tiled_routing_extract(
    *,
    spec: RegionSpec,
    input_dir: Path,
    overpass_url: str,
    max_time_seconds: int,
    routing_query_script: Path,
    render_query_fn: Callable[..., str],
    fetch_overpass_json_fn: Callable[..., None],
    stderr: TextIO,
) -> None:
    tile_size_degrees = spec.routing_tile_size_degrees
    if tile_size_degrees is None:
        raise ValueError("routing_tile_size_degrees is required for tiled routing fetch")

    bounds_payload = fetch_overpass_payload(
        query_text=build_relation_bounds_query(spec.location_relation),
        overpass_url=overpass_url,
        max_time_seconds=min(max_time_seconds, 60),
        fetch_overpass_json_fn=fetch_overpass_json_fn,
    )
    bounds = parse_relation_bounds(bounds_payload)
    bboxes = build_bbox_tiles(bounds, tile_size_degrees)
    _log(stderr, f"Fetching routing extract for {spec.name} across {len(bboxes)} bbox tiles")

    tile_payloads: list[dict[str, Any]] = []
    for tile_index, bbox in enumerate(bboxes, start=1):
        bbox_text = format_bbox(bbox)
        _log(
            stderr,
            f"Fetching routing tile {tile_index}/{len(bboxes)} for {spec.name}: {bbox_text}",
        )
        routing_query = render_query_fn(
            routing_query_script,
            "--location-label",
            spec.name,
            "--location-relation",
            spec.location_relation,
            "--bbox",
            bbox_text,
        )
        tile_payloads.append(
            fetch_overpass_payload(
                query_text=routing_query,
                overpass_url=overpass_url,
                max_time_seconds=max_time_seconds,
                fetch_overpass_json_fn=fetch_overpass_json_fn,
            )
        )

    merged_payload = merge_overpass_json_payloads(tile_payloads)
    output_path = input_dir / spec.routing_input_file_name
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(merged_payload), encoding="utf-8")


def fetch_overpass_payload(
    *,
    query_text: str,
    overpass_url: str,
    max_time_seconds: int,
    fetch_overpass_json_fn: Callable[..., None] | None = None,
) -> dict[str, Any]:
    fetch_overpass_json_fn = fetch_overpass_json_fn or fetch_overpass_json
    with tempfile.TemporaryDirectory(prefix="overpass-payload-") as temp_dir:
        output_path = Path(temp_dir) / "payload.json"
        fetch_overpass_json_fn(
            query_text=query_text,
            output_path=output_path,
            overpass_url=overpass_url,
            max_time_seconds=max_time_seconds,
        )
        payload = json.loads(output_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("Overpass payload must be a JSON object")
        return cast(dict[str, Any], payload)


def build_relation_bounds_query(location_relation: str) -> str:
    return f"[out:json][timeout:60];\n{location_relation};\nout bb;\n"


def parse_relation_bounds(payload: dict[str, Any]) -> tuple[float, float, float, float]:
    elements = payload.get("elements")
    if not isinstance(elements, list) or not elements:
        raise ValueError("bounds payload must contain a non-empty elements array")

    parsed_bounds: list[tuple[float, float, float, float]] = []
    for element in elements:
        if not isinstance(element, dict):
            continue
        bounds = element.get("bounds")
        if not isinstance(bounds, dict):
            continue
        parsed_bounds.append(
            (
                _require_coordinate(bounds.get("minlat"), "bounds.minlat"),
                _require_coordinate(bounds.get("minlon"), "bounds.minlon"),
                _require_coordinate(bounds.get("maxlat"), "bounds.maxlat"),
                _require_coordinate(bounds.get("maxlon"), "bounds.maxlon"),
            )
        )

    if not parsed_bounds:
        raise ValueError("bounds payload must include at least one bounds object")

    south = min(bound[0] for bound in parsed_bounds)
    west = min(bound[1] for bound in parsed_bounds)
    north = max(bound[2] for bound in parsed_bounds)
    east = max(bound[3] for bound in parsed_bounds)
    if south >= north or west >= east:
        raise ValueError("bounds payload contains an invalid bounding box")
    return (south, west, north, east)


def build_bbox_tiles(
    bounds: tuple[float, float, float, float],
    tile_size_degrees: float,
) -> list[tuple[float, float, float, float]]:
    south, west, north, east = bounds
    if tile_size_degrees <= 0:
        raise ValueError("tile_size_degrees must be positive")

    bboxes: list[tuple[float, float, float, float]] = []
    tile_south = south
    while tile_south < north:
        tile_north = min(tile_south + tile_size_degrees, north)
        tile_west = west
        while tile_west < east:
            tile_east = min(tile_west + tile_size_degrees, east)
            bboxes.append((tile_south, tile_west, tile_north, tile_east))
            tile_west = tile_east
        tile_south = tile_north
    return bboxes


def format_bbox(bbox: tuple[float, float, float, float]) -> str:
    south, west, north, east = bbox
    return f"{south:.6f},{west:.6f},{north:.6f},{east:.6f}"


def merge_overpass_json_payloads(payloads: Sequence[dict[str, Any]]) -> dict[str, Any]:
    merged_payload: dict[str, Any] = {}
    merged_elements: list[dict[str, Any]] = []
    merged_by_key: dict[tuple[str, int], dict[str, Any]] = {}

    for payload in payloads:
        if not merged_payload:
            for metadata_key in ("version", "generator", "osm3s"):
                if metadata_key in payload:
                    merged_payload[metadata_key] = payload[metadata_key]

        elements = payload.get("elements")
        if not isinstance(elements, list):
            raise ValueError("Overpass payload must contain an elements array")
        for element in elements:
            if not isinstance(element, dict):
                raise ValueError("Overpass elements must be objects")
            element_type = element.get("type")
            element_id = element.get("id")
            if not isinstance(element_type, str) or not isinstance(element_id, int):
                raise ValueError("Overpass elements must include string type and integer id")
            key = (element_type, element_id)
            existing = merged_by_key.get(key)
            if existing is None:
                copied = _copy_overpass_element(element)
                merged_by_key[key] = copied
                merged_elements.append(copied)
            else:
                _merge_overpass_element(existing, element)

    merged_payload["elements"] = merged_elements
    return merged_payload


def fetch_overpass_json(
    *,
    query_text: str,
    output_path: Path,
    overpass_url: str,
    max_time_seconds: int,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        prefix="overpass-query-",
        suffix=".ql",
        delete=False,
    ) as temp_query:
        temp_query.write(query_text)
        temp_query_path = Path(temp_query.name)

    temp_output_path = output_path.parent / f".{output_path.name}.tmp"

    try:
        result = subprocess.run(
            [
                "curl",
                "--show-error",
                "--fail",
                "--max-time",
                str(max_time_seconds),
                "--data-urlencode",
                f"data@{temp_query_path}",
                overpass_url,
                "-o",
                str(temp_output_path),
            ],
            check=False,
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or f"curl failed for {output_path}")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        temp_output_path.replace(output_path)
    finally:
        temp_query_path.unlink(missing_ok=True)
        temp_output_path.unlink(missing_ok=True)


def gzip_file(input_path: Path, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with input_path.open("rb") as source, gzip.open(output_path, "wb") as target:
        shutil.copyfileobj(source, target)


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

    if args.command in {"fetch", "all"}:
        run_fetch_pipeline(
            region_specs,
            input_dir=args.input_dir,
            overpass_url=args.overpass_url,
            max_time_seconds=args.max_time_seconds,
            stderr=stderr,
        )

    if args.command in {"build", "all"}:
        manifest = run_build_pipeline(
            region_specs,
            input_dir=args.input_dir,
            output_dir=args.output_dir,
            stderr=stderr,
        )
        json.dump(manifest, stdout, indent=2)
        stdout.write("\n")

    return 0


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    common_parser = argparse.ArgumentParser(add_help=False)
    common_parser.add_argument(
        "--locations-file",
        type=Path,
        default=DEFAULT_LOCATIONS_FILE,
        help="Path to external region configuration JSON.",
    )
    common_parser.add_argument(
        "--only",
        action="append",
        default=[],
        help="Limit processing to specific region ids (repeatable or comma-separated).",
    )
    common_parser.add_argument(
        "--input-dir",
        type=Path,
        default=DEFAULT_INPUT_DIR,
        help="Directory for raw Overpass JSON inputs.",
    )

    fetch_common_parser = argparse.ArgumentParser(add_help=False)
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

    subparsers.add_parser(
        "fetch",
        parents=[common_parser, fetch_common_parser],
        help="Download raw Overpass JSON only.",
    )

    build_parser = subparsers.add_parser(
        "build",
        parents=[common_parser],
        help="Build boundary canvas JSON, binary graphs, and gzip artifacts from raw inputs.",
    )
    build_parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory for generated artifact outputs.",
    )

    all_parser = subparsers.add_parser(
        "all",
        parents=[common_parser, fetch_common_parser],
        help="Run fetch plus build, then emit the UI locations manifest JSON to stdout.",
    )
    all_parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory for generated artifact outputs.",
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


def _optional_positive_float(value: object, field_name: str) -> float | None:
    if value is None:
        return None
    parsed = _require_float(value, field_name)
    if parsed <= 0:
        raise ValueError(f"{field_name} must be positive")
    return parsed


def _require_coordinate(value: object, field_name: str) -> float:
    return _require_float(value, field_name)


def _copy_overpass_element(element: dict[str, Any]) -> dict[str, Any]:
    copied: dict[str, Any] = {}
    for key, value in element.items():
        if isinstance(value, dict):
            copied[key] = dict(value)
        elif isinstance(value, list):
            copied[key] = list(value)
        else:
            copied[key] = value
    return copied


def _merge_overpass_element(existing: dict[str, Any], incoming: dict[str, Any]) -> None:
    for key, value in incoming.items():
        if key == "tags" and isinstance(value, dict):
            existing_tags = existing.get("tags")
            if not isinstance(existing_tags, dict):
                existing["tags"] = dict(value)
            else:
                for tag_key, tag_value in value.items():
                    existing_tags.setdefault(tag_key, tag_value)
            continue
        if key not in existing:
            if isinstance(value, list):
                existing[key] = list(value)
            elif isinstance(value, dict):
                existing[key] = dict(value)
            else:
                existing[key] = value


def _require_int(value: object, field_name: str) -> int:
    if not isinstance(value, int):
        raise ValueError(f"{field_name} must be an integer")
    return value


def _require_float(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"{field_name} must be a number")
    return float(value)
