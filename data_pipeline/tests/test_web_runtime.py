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


def parse_exported_numeric_constants(js_source: str) -> dict[str, float]:
    matches = re.finditer(
        r"export const (?P<name>[A-Z0-9_]+)\s*=\s*(?P<value>-?\d+(?:\.\d+)?);",
        js_source,
    )
    return {match.group("name"): float(match.group("value")) for match in matches}


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
        "theme-radio-group",
        "primary-mouse-button-group",
        "unit-system-radio-group",
        "mode-checkbox-group",
        "colour-cycle-minutes",
        "walk-speed-kph",
        "bike-speed-kph",
        "transit-walk-budget-minutes",
        "departure-datetime",
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
    # Every group of related controls carries an accessible name, so that a
    # screen reader announces what "Auto" or "Metric" is a choice *about*
    # rather than reading the options bare. A <fieldset> gets that from its
    # <legend>; #speed-group cannot be a fieldset - subgrid resolves to zero
    # columns through a fieldset's anonymous content box, which is what aligns
    # its label/input/unit columns - so it uses the role=group/aria-labelledby
    # spelling of the same thing.
    for group_id in (
        "mode-checkbox-group",
        "theme-radio-group",
        "unit-system-radio-group",
        "primary-mouse-button-group",
    ):
        assert parsed.elements_by_id[group_id].tag == "fieldset", group_id

    speed_group = parsed.elements_by_id["speed-group"]
    assert speed_group.attrs.get("role") == "group"
    labelled_by = speed_group.attrs.get("aria-labelledby", "")
    assert (
        labelled_by in parsed.elements_by_id
    ), f"#speed-group is labelled by {labelled_by!r}, which no element carries"

    colour_cycle_input = parsed.elements_by_id["colour-cycle-minutes"]
    assert colour_cycle_input.tag == "input"
    assert colour_cycle_input.attrs["type"] == "number"
    assert colour_cycle_input.attrs["min"] == "5"
    assert colour_cycle_input.attrs["step"] == "5"
    assert colour_cycle_input.attrs["value"] == "75"

    departure_datetime_input = parsed.elements_by_id["departure-datetime"]
    assert departure_datetime_input.tag == "input"
    assert departure_datetime_input.attrs["type"] == "datetime-local"
    assert departure_datetime_input.attrs["step"] == "60"

    # The speed inputs' HTML defaults must agree with the JS constants, or a
    # fresh page shows one speed while routing uses another.
    constants_js = (WEB_ROOT / "src" / "config" / "constants.js").read_text(encoding="utf-8")
    numeric_constants = parse_exported_numeric_constants(constants_js)

    walk_speed_input = parsed.elements_by_id["walk-speed-kph"]
    assert walk_speed_input.tag == "input"
    assert walk_speed_input.attrs["type"] == "number"
    assert float(walk_speed_input.attrs["value"]) == numeric_constants["DEFAULT_WALK_SPEED_KPH"]

    bike_speed_input = parsed.elements_by_id["bike-speed-kph"]
    assert bike_speed_input.tag == "input"
    assert bike_speed_input.attrs["type"] == "number"
    assert float(bike_speed_input.attrs["value"]) == numeric_constants["BIKE_CRUISE_SPEED_KPH"]

    walk_budget_input = parsed.elements_by_id["transit-walk-budget-minutes"]
    assert walk_budget_input.tag == "input"
    assert walk_budget_input.attrs["type"] == "number"
    assert (
        float(walk_budget_input.attrs["value"])
        == numeric_constants["DEFAULT_TRANSIT_WALK_BUDGET_MINUTES"]
    )

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
    assert (
        package_json["scripts"]["test:js"]
        == "node --import ./web/tests/no-network.js --test web/tests"
    )

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
    assert markdown_links["Region Data Pipeline"] == "docs/region-data-pipeline.md"
    assert markdown_links["WASM Routing Kernel"] == "docs/wasm-routing-kernel.md"
    assert markdown_links["Graph Binary Schema v3"] == "docs/graph-binary-schema-v3.md"


def collect_i18n_keys_from_index_html() -> set[str]:
    """Every localisation key index.html asks for, text and attribute alike."""
    markup = (WEB_ROOT / "index.html").read_text(encoding="utf-8")
    return set(re.findall(r'data-i18n(?:-attr-[a-z-]+)?="([^"]+)"', markup))


def load_locale_bundles() -> dict[str, dict[str, str]]:
    locales_root = WEB_ROOT / "locales"
    return {
        path.parent.name: json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(locales_root.glob("*/common.json"))
    }


def test_locale_bundles_cover_every_key_the_markup_asks_for() -> None:
    bundles = load_locale_bundles()
    assert set(bundles) >= {"en", "de", "fr"}

    requested = collect_i18n_keys_from_index_html()
    assert requested, "index.html declares no data-i18n keys, which cannot be right"

    for locale, messages in bundles.items():
        missing = sorted(requested.difference(messages))
        assert not missing, f"{locale} is missing keys used by index.html: {missing}"


def test_locale_bundles_agree_on_their_key_sets() -> None:
    """A key added to one language and forgotten in the others silently falls
    back to English at runtime, which reads as a half-translated panel rather
    than as an error. Compare the sets instead of waiting to notice."""
    bundles = load_locale_bundles()
    reference_locale, reference = next(iter(sorted(bundles.items())))

    for locale, messages in sorted(bundles.items()):
        if locale == reference_locale:
            continue
        only_here = sorted(set(messages).difference(reference))
        only_there = sorted(set(reference).difference(messages))
        assert not only_here, f"{locale} has keys {reference_locale} lacks: {only_here}"
        assert not only_there, f"{locale} lacks keys {reference_locale} has: {only_there}"


def test_locale_bundles_carry_no_orphan_keys() -> None:
    """Keys nothing references are translation debt: they get maintained and
    re-translated forever without ever reaching a user."""
    bundles = load_locale_bundles()
    referenced = collect_i18n_keys_from_index_html()
    # Some keys are only ever built at runtime - `export.mode.${modeValue}` -
    # so a literal-only sweep would call every one of them an orphan. Treat the
    # static part of such a template as covering the whole family.
    dynamic_prefixes: set[str] = set()
    for source in sorted(WEB_ROOT.glob("src/**/*.js")):
        js = source.read_text(encoding="utf-8")
        referenced.update(re.findall(r"['\"]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)['\"]", js))
        dynamic_prefixes.update(re.findall(r"`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*\.)\$\{", js))

    orphans = sorted(
        key
        for key in bundles["en"]
        if key not in referenced and not any(key.startswith(prefix) for prefix in dynamic_prefixes)
    )
    assert not orphans, f"locale keys nothing references: {orphans}"
