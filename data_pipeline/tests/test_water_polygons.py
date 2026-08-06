import zipfile
from pathlib import Path

import pytest
from isochrone_pipeline import water_polygons
from isochrone_pipeline.water_polygons import (
    _cache_filename_for_url,
    _fetch_cached_archive,
    load_clipped_water_polygon_features,
)

FAKE_SOURCE_URL = "https://osmdata.openstreetmap.de/download/water-polygons-split-4326.zip"


def _write_test_water_polygons_zip(zip_path: Path) -> None:
    import shapefile

    source_dir = zip_path.parent / "water_source"
    source_dir.mkdir(parents=True, exist_ok=True)
    shapefile_base = source_dir / "water_polygons"

    writer = shapefile.Writer(str(shapefile_base), shapeType=shapefile.POLYGON)
    writer.field("name", "C")
    writer.poly(
        [
            [
                [13.3600, 52.5190],
                [13.3900, 52.5190],
                [13.3900, 52.5220],
                [13.3600, 52.5220],
                [13.3600, 52.5190],
            ]
        ]
    )
    writer.record("ocean")
    writer.close()

    with zipfile.ZipFile(zip_path, "w") as archive:
        for suffix in (".shp", ".shx", ".dbf"):
            file_path = shapefile_base.with_suffix(suffix)
            archive.write(file_path, arcname=file_path.name)


def test_cache_filename_for_url_uses_basename() -> None:
    assert _cache_filename_for_url(FAKE_SOURCE_URL) == "water-polygons-split-4326.zip"


def test_cache_filename_for_url_falls_back_when_path_has_no_name() -> None:
    assert _cache_filename_for_url("https://example.com/") == "water-polygons.zip"


def test_fetch_cached_archive_downloads_once_and_reuses_cache(tmp_path, monkeypatch) -> None:
    cache_dir = tmp_path / "cache"
    download_calls = []

    def fake_download(url: str, output_path: Path) -> None:
        download_calls.append(url)
        _write_test_water_polygons_zip(output_path)

    monkeypatch.setattr(water_polygons, "_download_to_path", fake_download)

    first_path = _fetch_cached_archive(FAKE_SOURCE_URL, cache_dir=cache_dir)
    second_path = _fetch_cached_archive(FAKE_SOURCE_URL, cache_dir=cache_dir)

    assert download_calls == [FAKE_SOURCE_URL]
    assert first_path == second_path == cache_dir / "water-polygons-split-4326.zip"
    assert first_path.is_file()
    leftover_temp_files = list(cache_dir.glob(".download-*"))
    assert leftover_temp_files == []


def test_fetch_cached_archive_leaves_no_partial_file_on_download_failure(
    tmp_path, monkeypatch
) -> None:
    cache_dir = tmp_path / "cache"

    def failing_download(url: str, output_path: Path) -> None:
        del url, output_path
        raise RuntimeError("network error")

    monkeypatch.setattr(water_polygons, "_download_to_path", failing_download)

    with pytest.raises(RuntimeError):
        _fetch_cached_archive(FAKE_SOURCE_URL, cache_dir=cache_dir)

    assert not (cache_dir / "water-polygons-split-4326.zip").exists()
    assert list(cache_dir.glob("*")) == []


def test_load_clipped_water_polygon_features_uses_cache_dir_for_http_source(
    tmp_path, monkeypatch
) -> None:
    cache_dir = tmp_path / "cache"
    download_calls = []

    def fake_download(url: str, output_path: Path) -> None:
        download_calls.append(url)
        _write_test_water_polygons_zip(output_path)

    monkeypatch.setattr(water_polygons, "_download_to_path", fake_download)

    clip_bbox = (13.37, 52.519, 13.39, 52.521)

    first_features = load_clipped_water_polygon_features(
        source=FAKE_SOURCE_URL,
        clip_bbox=clip_bbox,
        cache_dir=cache_dir,
    )
    second_features = load_clipped_water_polygon_features(
        source=FAKE_SOURCE_URL,
        clip_bbox=clip_bbox,
        cache_dir=cache_dir,
    )

    assert download_calls == [FAKE_SOURCE_URL]
    assert first_features == second_features
    assert len(first_features) == 1
