import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = REPO_ROOT / "web"


def test_index_html_uses_native_module_entrypoint() -> None:
    index_html = (WEB_ROOT / "index.html").read_text(encoding="utf-8")

    assert 'id="boundaries"' in index_html
    assert 'id="map"' in index_html
    assert 'id="loading"' in index_html
    assert "dist/app.js" not in index_html
    assert re.search(
        r'<script[^>]*type="module"[^>]*src="\./src/app\.js"',
        index_html,
        flags=re.IGNORECASE,
    )


def test_web_directory_has_no_node_toolchain_files() -> None:
    assert not (REPO_ROOT / ".prettierrc.json").exists()
    assert not (WEB_ROOT / "package.json").exists()
    assert not (WEB_ROOT / "package-lock.json").exists()
    assert not (WEB_ROOT / "eslint.config.js").exists()
    assert not (WEB_ROOT / "tests").exists()
