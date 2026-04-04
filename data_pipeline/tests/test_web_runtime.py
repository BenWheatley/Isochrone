from __future__ import annotations

import json
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = REPO_ROOT / "web"


@dataclass(frozen=True)
class HtmlElement:
    tag: str
    attrs: dict[str, str]


class IndexHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title_text_parts: list[str] = []
        self._inside_title = False
        self.elements_by_id: dict[str, HtmlElement] = {}
        self.scripts: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {key: value if value is not None else "" for key, value in attrs}
        element_id = attr_map.get("id")
        if element_id:
            if element_id in self.elements_by_id:
                raise AssertionError(f"duplicate id in index.html: {element_id}")
            self.elements_by_id[element_id] = HtmlElement(tag=tag, attrs=attr_map)

        if tag == "script":
            self.scripts.append(attr_map)
        if tag == "title":
            self._inside_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._inside_title = False

    def handle_data(self, data: str) -> None:
        if self._inside_title:
            self.title_text_parts.append(data)

    @property
    def title_text(self) -> str:
        return "".join(self.title_text_parts).strip()


def parse_index_html() -> IndexHtmlParser:
    parser = IndexHtmlParser()
    parser.feed((WEB_ROOT / "index.html").read_text(encoding="utf-8"))
    return parser


def parse_exported_string_constants(js_source: str) -> dict[str, str]:
    matches = re.finditer(
        r"export const (?P<name>[A-Z0-9_]+)\s*=\s*'(?P<value>[^']+)';",
        js_source,
    )
    return {match.group("name"): match.group("value") for match in matches}


def parse_markdown_links(markdown_text: str) -> dict[str, str]:
    matches = re.finditer(r"\[(?P<label>[^\]]+)\]\((?P<target>[^)]+)\)", markdown_text)
    return {match.group("label"): match.group("target") for match in matches}


def assert_positive_integer_attribute(element: HtmlElement, attribute_name: str) -> None:
    attribute_value = element.attrs.get(attribute_name, "")
    assert attribute_value.isdigit()
    assert int(attribute_value) > 0


def test_index_html_exposes_expected_runtime_shell_contract() -> None:
    parsed = parse_index_html()

    assert parsed.title_text == "Isochrone"

    required_ids = {
        "map-region",
        "canvas-stack",
        "boundaries",
        "isochrone",
        "loading",
        "loading-text",
        "loading-progress-bar",
        "routing-status",
        "render-backend-badge",
        "routing-disclaimer",
        "location-select",
        "controls-menu",
        "controls-menu-summary",
        "theme-select",
        "invert-pointer-buttons",
        "mode-select",
        "colour-cycle-minutes",
        "departure-time",
        "export-svg-button",
        "isochrone-legend",
        "distance-scale",
        "distance-scale-line",
        "distance-scale-label",
    }
    missing_ids = required_ids.difference(parsed.elements_by_id)
    assert not missing_ids, f"missing required runtime shell ids: {sorted(missing_ids)}"

    assert parsed.elements_by_id["map-region"].tag == "section"
    assert parsed.elements_by_id["map-region"].attrs["aria-label"] == "Map viewport"

    assert parsed.elements_by_id["canvas-stack"].tag == "div"
    assert parsed.elements_by_id["boundaries"].tag == "canvas"
    assert parsed.elements_by_id["isochrone"].tag == "canvas"
    assert_positive_integer_attribute(parsed.elements_by_id["boundaries"], "width")
    assert_positive_integer_attribute(parsed.elements_by_id["boundaries"], "height")
    assert_positive_integer_attribute(parsed.elements_by_id["isochrone"], "width")
    assert_positive_integer_attribute(parsed.elements_by_id["isochrone"], "height")

    assert parsed.elements_by_id["loading"].tag == "div"
    assert parsed.elements_by_id["loading"].attrs["role"] == "status"
    assert parsed.elements_by_id["loading"].attrs["aria-live"] == "polite"
    assert parsed.elements_by_id["routing-status"].tag == "div"
    assert parsed.elements_by_id["routing-status"].attrs["role"] == "status"
    assert parsed.elements_by_id["routing-status"].attrs["aria-live"] == "polite"

    assert parsed.elements_by_id["location-select"].tag == "select"
    assert parsed.elements_by_id["location-select"].attrs["name"] == "location-select"
    assert parsed.elements_by_id["theme-select"].tag == "select"
    assert parsed.elements_by_id["mode-select"].tag == "select"
    assert parsed.elements_by_id["mode-select"].attrs["multiple"] == ""
    assert parsed.elements_by_id["mode-select"].attrs["size"] == "3"
    assert parsed.elements_by_id["invert-pointer-buttons"].tag == "input"
    assert parsed.elements_by_id["invert-pointer-buttons"].attrs["type"] == "checkbox"

    colour_cycle_input = parsed.elements_by_id["colour-cycle-minutes"]
    assert colour_cycle_input.tag == "input"
    assert colour_cycle_input.attrs["type"] == "number"
    assert colour_cycle_input.attrs["min"] == "5"
    assert colour_cycle_input.attrs["step"] == "5"
    assert colour_cycle_input.attrs["value"] == "75"

    departure_time_input = parsed.elements_by_id["departure-time"]
    assert departure_time_input.tag == "input"
    assert departure_time_input.attrs["type"] == "time"
    assert departure_time_input.attrs["value"] == "08:00"
    assert departure_time_input.attrs["step"] == "60"

    export_button = parsed.elements_by_id["export-svg-button"]
    assert export_button.tag == "button"
    assert export_button.attrs["type"] == "button"
    assert "disabled" in export_button.attrs

    app_module_scripts = [
        attrs
        for attrs in parsed.scripts
        if attrs.get("type") == "module" and attrs.get("src") == "./src/app.js"
    ]
    assert len(app_module_scripts) == 1


def test_runtime_defaults_and_registry_are_consistent() -> None:
    constants_js = (WEB_ROOT / "src" / "config" / "constants.js").read_text(encoding="utf-8")
    exported_constants = parse_exported_string_constants(constants_js)
    location_registry = json.loads(
        (WEB_ROOT / "src" / "data" / "locations.json").read_text(encoding="utf-8")
    )

    assert exported_constants["DEFAULT_LOCATION_REGISTRY_URL"] == "../data/locations.json"
    assert exported_constants["DEFAULT_LOCATION_ID"] == "berlin"
    assert exported_constants["DEFAULT_LOCATION_NAME"] == "Berlin"
    assert (
        exported_constants["DEFAULT_BOUNDARY_FILE_NAME"] == "berlin-district-boundaries-canvas.json"
    )
    assert exported_constants["DEFAULT_GRAPH_FILE_NAME"] == "graph-walk.bin.gz"

    berlin_entry = next(
        entry
        for entry in location_registry["locations"]
        if entry["id"] == exported_constants["DEFAULT_LOCATION_ID"]
    )
    assert berlin_entry["name"] == exported_constants["DEFAULT_LOCATION_NAME"]
    assert berlin_entry["boundaryFileName"] == exported_constants["DEFAULT_BOUNDARY_FILE_NAME"]
    assert berlin_entry["graphFileName"] == exported_constants["DEFAULT_GRAPH_FILE_NAME"]


def test_quality_gates_cover_python_and_js_runtime_checks() -> None:
    package_json = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    makefile = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")
    ci_workflow = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert package_json["scripts"]["lint:js"] == "eslint web/src web/tests"
    assert package_json["scripts"]["test:js"] == "node --test web/tests"

    assert "$(RUFF) check data_pipeline" in makefile
    assert "$(MYPY) data_pipeline/src" in makefile
    assert "$(PYTEST) -q" in makefile
    assert "$(NPM) run --silent lint:js" in makefile
    assert "$(NPM) run --silent test:js" in makefile

    assert "npm run --silent lint:js" in ci_workflow
    assert "ruff check data_pipeline" in ci_workflow
    assert "mypy data_pipeline/src" in ci_workflow
    assert "pytest -q" in ci_workflow
    assert "npm run --silent test:js" in ci_workflow


def test_readme_links_live_app_and_discussed_docs() -> None:
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    markdown_links = parse_markdown_links(readme)

    assert markdown_links["Live App"] == "https://benwheatley.github.io/Isochrone/"
    assert markdown_links["Region Data Pipeline"] == "docs/region-data-pipeline.md"
    assert markdown_links["WASM Routing Kernel"] == "docs/wasm-routing-kernel.md"
    assert markdown_links["Graph Binary Schema v2"] == "docs/graph-binary-schema-v2.md"
    assert "fetch-data.sh" not in readme
