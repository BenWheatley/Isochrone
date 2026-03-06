from isochrone_pipeline.adjacency import AdjacencyGraph, GraphEdge, GraphNode
from isochrone_pipeline.simplify import (
    NODE_FLAG_STOP_ATTACHMENT,
    simplify_degree2_chains,
)


def _graph(nodes: list[GraphNode], edges: list[GraphEdge]) -> AdjacencyGraph:
    return AdjacencyGraph(nodes=tuple(nodes), edges=tuple(edges), skipped_constraint_way_count=0)


def test_merges_simple_bidirectional_degree2_chain() -> None:
    graph = _graph(
        nodes=[
            GraphNode(osm_id=10, x_m=0, y_m=0, first_edge_index=0, edge_count=0, flags=0),
            GraphNode(osm_id=11, x_m=10, y_m=0, first_edge_index=0, edge_count=0, flags=0),
            GraphNode(osm_id=12, x_m=20, y_m=0, first_edge_index=0, edge_count=0, flags=0),
        ],
        edges=[
            GraphEdge(source_index=0, target_index=1, cost_seconds=5, flags=0),
            GraphEdge(source_index=1, target_index=0, cost_seconds=5, flags=0),
            GraphEdge(source_index=1, target_index=2, cost_seconds=7, flags=0),
            GraphEdge(source_index=2, target_index=1, cost_seconds=7, flags=0),
        ],
    )

    result = simplify_degree2_chains(graph)

    assert result.before_node_count == 3
    assert result.after_node_count == 2
    assert result.after_edge_count == 2
    assert {edge.cost_seconds for edge in result.graph.edges} == {12}


def test_stop_attachment_nodes_are_not_merge_candidates() -> None:
    graph = _graph(
        nodes=[
            GraphNode(osm_id=10, x_m=0, y_m=0, first_edge_index=0, edge_count=0, flags=0),
            GraphNode(osm_id=11, x_m=10, y_m=0, first_edge_index=0, edge_count=0, flags=0),
            GraphNode(osm_id=12, x_m=20, y_m=0, first_edge_index=0, edge_count=0, flags=0),
        ],
        edges=[
            GraphEdge(source_index=0, target_index=1, cost_seconds=5, flags=0),
            GraphEdge(source_index=1, target_index=0, cost_seconds=5, flags=0),
            GraphEdge(source_index=1, target_index=2, cost_seconds=7, flags=0),
            GraphEdge(source_index=2, target_index=1, cost_seconds=7, flags=0),
        ],
    )

    result = simplify_degree2_chains(graph, stop_attachment_osm_ids={11})

    assert result.after_node_count == 3
    middle = next(node for node in result.graph.nodes if node.osm_id == 11)
    assert middle.flags & NODE_FLAG_STOP_ATTACHMENT


def test_oneway_chain_merges_forward_only() -> None:
    graph = _graph(
        nodes=[
            GraphNode(osm_id=20, x_m=0, y_m=0, first_edge_index=0, edge_count=0, flags=0),
            GraphNode(osm_id=21, x_m=10, y_m=0, first_edge_index=0, edge_count=0, flags=0),
            GraphNode(osm_id=22, x_m=20, y_m=0, first_edge_index=0, edge_count=0, flags=0),
        ],
        edges=[
            GraphEdge(source_index=0, target_index=1, cost_seconds=6, flags=0),
            GraphEdge(source_index=1, target_index=2, cost_seconds=7, flags=0),
        ],
    )

    result = simplify_degree2_chains(graph)

    assert result.after_node_count == 2
    assert result.after_edge_count == 1
    edge = result.graph.edges[0]
    assert edge.cost_seconds == 13


def test_chain_overflow_keeps_break_nodes_and_caps_edge_costs() -> None:
    graph = _graph(
        nodes=[
            GraphNode(osm_id=30, x_m=0, y_m=0, first_edge_index=0, edge_count=0, flags=0),
            GraphNode(osm_id=31, x_m=10, y_m=0, first_edge_index=0, edge_count=0, flags=0),
            GraphNode(osm_id=32, x_m=20, y_m=0, first_edge_index=0, edge_count=0, flags=0),
        ],
        edges=[
            GraphEdge(source_index=0, target_index=1, cost_seconds=40_000, flags=0),
            GraphEdge(source_index=1, target_index=2, cost_seconds=40_000, flags=0),
            GraphEdge(source_index=2, target_index=1, cost_seconds=40_000, flags=0),
            GraphEdge(source_index=1, target_index=0, cost_seconds=40_000, flags=0),
        ],
    )

    result = simplify_degree2_chains(graph)

    assert result.after_node_count == 3
    assert result.after_edge_count == 4
    assert all(edge.cost_seconds <= 65535 for edge in result.graph.edges)


def test_reindexed_nodes_have_consistent_edge_ranges() -> None:
    graph = _graph(
        nodes=[
            GraphNode(osm_id=40, x_m=0, y_m=0, first_edge_index=0, edge_count=0, flags=0),
            GraphNode(osm_id=41, x_m=10, y_m=0, first_edge_index=0, edge_count=0, flags=0),
            GraphNode(osm_id=42, x_m=20, y_m=0, first_edge_index=0, edge_count=0, flags=0),
        ],
        edges=[
            GraphEdge(source_index=0, target_index=1, cost_seconds=5, flags=0),
            GraphEdge(source_index=1, target_index=2, cost_seconds=5, flags=0),
            GraphEdge(source_index=2, target_index=1, cost_seconds=5, flags=0),
            GraphEdge(source_index=1, target_index=0, cost_seconds=5, flags=0),
        ],
    )

    result = simplify_degree2_chains(graph)

    edges = result.graph.edges
    for node_index, node in enumerate(result.graph.nodes):
        subset = edges[node.first_edge_index : node.first_edge_index + node.edge_count]
        assert all(edge.source_index == node_index for edge in subset)
