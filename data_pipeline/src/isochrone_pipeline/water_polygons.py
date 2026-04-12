"""Load and clip optional coastal water polygons for regional basemaps."""

from __future__ import annotations

import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlparse

import requests  # type: ignore[import-untyped]
import shapefile  # type: ignore[import-untyped]

DEFAULT_WATER_POLYGONS_SOURCE = (
    "https://osmdata.openstreetmap.de/download/water-polygons-split-4326.zip"
)

LonLatPoint = tuple[float, float]
LonLatRing = tuple[LonLatPoint, ...]
LonLatMultiRing = tuple[LonLatRing, ...]
LonLatBbox = tuple[float, float, float, float]


def load_clipped_water_polygon_features(
    *,
    source: str | Path = DEFAULT_WATER_POLYGONS_SOURCE,
    clip_bbox: LonLatBbox,
) -> tuple[LonLatMultiRing, ...]:
    features: list[LonLatMultiRing] = []
    with _open_shapefile_reader(source) as reader:
        for shape in reader.iterShapes():
            if not _shape_bbox_intersects(shape.bbox, clip_bbox):
                continue

            clipped_rings: list[LonLatRing] = []
            for ring in _extract_polygon_rings(shape):
                clipped_ring = clip_ring_to_bbox(ring, clip_bbox)
                if len(clipped_ring) >= 4:
                    clipped_rings.append(clipped_ring)

            if clipped_rings:
                features.append(tuple(clipped_rings))

    return tuple(features)


def clip_ring_to_bbox(ring: LonLatRing, clip_bbox: LonLatBbox) -> LonLatRing:
    if len(ring) < 4:
        return tuple()

    points = list(ring[:-1] if ring[0] == ring[-1] else ring)
    if len(points) < 3:
        return tuple()

    min_lon, min_lat, max_lon, max_lat = clip_bbox
    for edge_name in ("left", "right", "bottom", "top"):
        points = _clip_polygon_against_edge(points, edge_name, min_lon, min_lat, max_lon, max_lat)
        if len(points) < 3:
            return tuple()

    if points[0] != points[-1]:
        points.append(points[0])
    return tuple(points)


@contextmanager
def _open_shapefile_reader(source: str | Path) -> Iterator[shapefile.Reader]:
    if _is_http_url(source):
        with TemporaryDirectory() as tmp_dir_name:
            archive_path = Path(tmp_dir_name) / "water-polygons.zip"
            _download_to_path(str(source), archive_path)
            with _open_shapefile_reader_from_archive(archive_path) as reader:
                yield reader
        return

    source_path = Path(source)
    if source_path.suffix.lower() == ".zip":
        with _open_shapefile_reader_from_archive(source_path) as reader:
            yield reader
        return

    if source_path.suffix.lower() == ".shp":
        reader = shapefile.Reader(str(source_path))
        try:
            yield reader
        finally:
            reader.close()
        return

    raise ValueError(f"Unsupported water polygon source: {source}")


@contextmanager
def _open_shapefile_reader_from_archive(archive_path: Path) -> Iterator[shapefile.Reader]:
    with TemporaryDirectory() as tmp_dir_name:
        extract_root = Path(tmp_dir_name)
        with zipfile.ZipFile(archive_path) as archive:
            shapefile_member = _select_shapefile_member(archive.namelist())
            shapefile_stem = shapefile_member[:-4]
            for member in archive.namelist():
                if not member.startswith(shapefile_stem):
                    continue
                if Path(member).suffix.lower() not in {".shp", ".shx", ".dbf", ".prj", ".cpg"}:
                    continue
                archive.extract(member, path=extract_root)

        reader = shapefile.Reader(str(extract_root / shapefile_member))
        try:
            yield reader
        finally:
            reader.close()


def _select_shapefile_member(member_names: list[str]) -> str:
    shapefile_members = [
        member_name
        for member_name in member_names
        if member_name.lower().endswith(".shp") and not member_name.startswith("__MACOSX/")
    ]
    if not shapefile_members:
        raise ValueError("Water polygon archive does not contain a .shp file")
    if len(shapefile_members) == 1:
        return shapefile_members[0]

    preferred_members = [
        member_name
        for member_name in shapefile_members
        if Path(member_name).stem.lower().startswith("water")
    ]
    if len(preferred_members) == 1:
        return preferred_members[0]

    raise ValueError("Water polygon archive contains multiple shapefiles; unable to choose one")


def _download_to_path(url: str, output_path: Path) -> None:
    response = requests.get(url, stream=True, timeout=(10, 300))
    response.raise_for_status()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("wb") as output_file:
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            if chunk:
                output_file.write(chunk)


def _extract_polygon_rings(shape: shapefile.Shape) -> tuple[LonLatRing, ...]:
    if shape.shapeType not in {
        shapefile.POLYGON,
        shapefile.POLYGONM,
        shapefile.POLYGONZ,
    }:
        return tuple()

    points = [(float(point[0]), float(point[1])) for point in shape.points]
    part_starts = list(shape.parts)
    if not part_starts:
        return tuple()

    rings: list[LonLatRing] = []
    for index, start in enumerate(part_starts):
        end = part_starts[index + 1] if index + 1 < len(part_starts) else len(points)
        ring_points = points[start:end]
        if len(ring_points) < 4:
            continue
        if ring_points[0] != ring_points[-1]:
            ring_points.append(ring_points[0])
        rings.append(tuple(ring_points))
    return tuple(rings)


def _shape_bbox_intersects(shape_bbox: list[float], clip_bbox: LonLatBbox) -> bool:
    if len(shape_bbox) != 4:
        return True
    shape_min_lon, shape_min_lat, shape_max_lon, shape_max_lat = (
        float(shape_bbox[0]),
        float(shape_bbox[1]),
        float(shape_bbox[2]),
        float(shape_bbox[3]),
    )
    clip_min_lon, clip_min_lat, clip_max_lon, clip_max_lat = clip_bbox
    return not (
        shape_max_lon < clip_min_lon
        or shape_min_lon > clip_max_lon
        or shape_max_lat < clip_min_lat
        or shape_min_lat > clip_max_lat
    )


def _clip_polygon_against_edge(
    points: list[LonLatPoint],
    edge_name: str,
    min_lon: float,
    min_lat: float,
    max_lon: float,
    max_lat: float,
) -> list[LonLatPoint]:
    if not points:
        return []

    output: list[LonLatPoint] = []
    previous = points[-1]
    previous_inside = _is_inside(previous, edge_name, min_lon, min_lat, max_lon, max_lat)

    for current in points:
        current_inside = _is_inside(current, edge_name, min_lon, min_lat, max_lon, max_lat)
        if current_inside:
            if not previous_inside:
                output.append(
                    _intersect_edge(
                        previous,
                        current,
                        edge_name,
                        min_lon,
                        min_lat,
                        max_lon,
                        max_lat,
                    )
                )
            output.append(current)
        elif previous_inside:
            output.append(
                _intersect_edge(previous, current, edge_name, min_lon, min_lat, max_lon, max_lat)
            )
        previous = current
        previous_inside = current_inside

    return output


def _is_inside(
    point: LonLatPoint,
    edge_name: str,
    min_lon: float,
    min_lat: float,
    max_lon: float,
    max_lat: float,
) -> bool:
    lon, lat = point
    if edge_name == "left":
        return lon >= min_lon
    if edge_name == "right":
        return lon <= max_lon
    if edge_name == "bottom":
        return lat >= min_lat
    if edge_name == "top":
        return lat <= max_lat
    raise ValueError(f"Unsupported clip edge: {edge_name}")


def _intersect_edge(
    start: LonLatPoint,
    end: LonLatPoint,
    edge_name: str,
    min_lon: float,
    min_lat: float,
    max_lon: float,
    max_lat: float,
) -> LonLatPoint:
    start_lon, start_lat = start
    end_lon, end_lat = end
    delta_lon = end_lon - start_lon
    delta_lat = end_lat - start_lat

    if edge_name in {"left", "right"}:
        boundary_lon = min_lon if edge_name == "left" else max_lon
        if delta_lon == 0:
            return (boundary_lon, start_lat)
        fraction = (boundary_lon - start_lon) / delta_lon
        return (boundary_lon, start_lat + fraction * delta_lat)

    boundary_lat = min_lat if edge_name == "bottom" else max_lat
    if delta_lat == 0:
        return (start_lon, boundary_lat)
    fraction = (boundary_lat - start_lat) / delta_lat
    return (start_lon + fraction * delta_lon, boundary_lat)


def _is_http_url(value: str | Path) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"}
