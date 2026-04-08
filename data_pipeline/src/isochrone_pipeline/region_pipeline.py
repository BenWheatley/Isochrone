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
QueryRenderer = Callable[..., str]
OverpassFetcher = Callable[..., None]


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
    render_query_fn: QueryRenderer | None = None,
    fetch_overpass_json_fn: OverpassFetcher | None = None,
    stderr: TextIO | None = None,
) -> None:
    stderr = stderr or sys.stderr
    input_dir.mkdir(parents=True, exist_ok=True)
    render_query_fn = render_query_fn or render_query
    fetch_overpass_json_fn = fetch_overpass_json_fn or fetch_overpass_json

    for spec in region_specs:
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
) -> str:
    message_lines = [
        f"Overpass request failed for {request_label}",
        f"output_path={output_path}",
        f"overpass_url={overpass_url}",
        f"max_time_seconds={max_time_seconds}",
        f"curl_exit_code={curl_exit_code}",
        f"http_status={http_status}",
        f"saved_query={debug_bundle['query']}",
        f"saved_curl_stderr={debug_bundle['stderr']}",
        f"saved_response_body={debug_bundle['response_body']}",
        f"saved_response_headers={debug_bundle['response_headers']}",
    ]
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


def _require_int(value: object, field_name: str) -> int:
    if not isinstance(value, int):
        raise ValueError(f"{field_name} must be an integer")
    return value


def _require_float(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"{field_name} must be a number")
    return float(value)
