"""Simplify adjacency graphs by contracting merge-safe degree-2 chains."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, replace

from .adjacency import MAX_EDGE_COST_SECONDS, AdjacencyGraph, GraphEdge, GraphNode

NODE_FLAG_STOP_ATTACHMENT = 1 << 4


@dataclass(frozen=True)
class SimplifyResult:
    graph: AdjacencyGraph
    before_node_count: int
    before_edge_count: int
    after_node_count: int
    after_edge_count: int
    merged_node_count: int


@dataclass
class _MutableEdge:
    source: int
    target: int
    cost_seconds: int
    flags: int
    alive: bool = True


@dataclass(frozen=True)
class _MergePlan:
    incoming_edge_ids: tuple[int, ...]
    outgoing_edge_ids: tuple[int, ...]
    replacements: tuple[GraphEdge, ...]


def simplify_degree2_chains(
    graph: AdjacencyGraph,
    *,
    stop_attachment_osm_ids: set[int] | None = None,
) -> SimplifyResult:
    stop_ids = stop_attachment_osm_ids or set()

    nodes = [
        replace(
            node,
            flags=(
                node.flags | NODE_FLAG_STOP_ATTACHMENT
                if node.osm_id is not None and node.osm_id in stop_ids
                else node.flags
            ),
        )
        for node in graph.nodes
    ]

    mutable_edges = [
        _MutableEdge(
            source=edge.source_index,
            target=edge.target_index,
            cost_seconds=min(edge.cost_seconds, MAX_EDGE_COST_SECONDS),
            flags=edge.flags,
        )
        for edge in graph.edges
    ]

    outgoing_ids: list[set[int]] = [set() for _ in nodes]
    incoming_ids: list[set[int]] = [set() for _ in nodes]

    for edge_id, edge in enumerate(mutable_edges):
        outgoing_ids[edge.source].add(edge_id)
        incoming_ids[edge.target].add(edge_id)

    removed_nodes = [False] * len(nodes)
    queue: deque[int] = deque(range(len(nodes)))
    queued = set(range(len(nodes)))
    merged_nodes = 0

    while queue:
        node_index = queue.popleft()
        queued.discard(node_index)

        if removed_nodes[node_index]:
            continue

        merge_plan = _build_merge_plan(
            node_index=node_index,
            nodes=nodes,
            removed_nodes=removed_nodes,
            edges=mutable_edges,
            incoming_ids=incoming_ids,
            outgoing_ids=outgoing_ids,
        )
        if merge_plan is None:
            continue

        impacted_nodes = _apply_merge_plan(
            node_index=node_index,
            merge_plan=merge_plan,
            removed_nodes=removed_nodes,
            edges=mutable_edges,
            incoming_ids=incoming_ids,
            outgoing_ids=outgoing_ids,
        )
        merged_nodes += 1

        for impacted in impacted_nodes:
            if removed_nodes[impacted] or impacted in queued:
                continue
            queue.append(impacted)
            queued.add(impacted)

    reindexed = _reindex_graph(
        nodes=nodes,
        removed_nodes=removed_nodes,
        edges=mutable_edges,
        skipped_constraint_way_count=graph.skipped_constraint_way_count,
    )

    return SimplifyResult(
        graph=reindexed,
        before_node_count=len(graph.nodes),
        before_edge_count=len(graph.edges),
        after_node_count=len(reindexed.nodes),
        after_edge_count=len(reindexed.edges),
        merged_node_count=merged_nodes,
    )


def _build_merge_plan(
    *,
    node_index: int,
    nodes: list[GraphNode],
    removed_nodes: list[bool],
    edges: list[_MutableEdge],
    incoming_ids: list[set[int]],
    outgoing_ids: list[set[int]],
) -> _MergePlan | None:
    node = nodes[node_index]
    if node.flags & NODE_FLAG_STOP_ATTACHMENT:
        return None

    neighbors = set()
    incoming = []
    outgoing = []

    for edge_id in incoming_ids[node_index]:
        edge = edges[edge_id]
        if not edge.alive:
            continue
        if removed_nodes[edge.source]:
            continue
        if edge.source == node_index:
            continue
        neighbors.add(edge.source)
        incoming.append(edge_id)

    for edge_id in outgoing_ids[node_index]:
        edge = edges[edge_id]
        if not edge.alive:
            continue
        if removed_nodes[edge.target]:
            continue
        if edge.target == node_index:
            continue
        neighbors.add(edge.target)
        outgoing.append(edge_id)

    if len(neighbors) != 2:
        return None
    if not incoming or not outgoing:
        return None

    replacement_costs: dict[tuple[int, int, int], int] = {}
    has_non_loop_pair = False

    for in_edge_id in incoming:
        in_edge = edges[in_edge_id]
        for out_edge_id in outgoing:
            out_edge = edges[out_edge_id]
            if in_edge.source == out_edge.target:
                continue
            has_non_loop_pair = True
            merged_cost = in_edge.cost_seconds + out_edge.cost_seconds
            if merged_cost > MAX_EDGE_COST_SECONDS:
                return None

            merged_flags = in_edge.flags | out_edge.flags
            key = (in_edge.source, out_edge.target, merged_flags)
            replacement_costs[key] = min(replacement_costs.get(key, merged_cost), merged_cost)

    if not has_non_loop_pair:
        return None

    replacements = tuple(
        GraphEdge(
            source_index=source,
            target_index=target,
            cost_seconds=cost,
            flags=flags,
        )
        for (source, target, flags), cost in replacement_costs.items()
    )

    if not replacements:
        return None

    return _MergePlan(
        incoming_edge_ids=tuple(incoming),
        outgoing_edge_ids=tuple(outgoing),
        replacements=replacements,
    )


def _apply_merge_plan(
    *,
    node_index: int,
    merge_plan: _MergePlan,
    removed_nodes: list[bool],
    edges: list[_MutableEdge],
    incoming_ids: list[set[int]],
    outgoing_ids: list[set[int]],
) -> set[int]:
    impacted: set[int] = set()

    incident_ids = set(merge_plan.incoming_edge_ids) | set(merge_plan.outgoing_edge_ids)
    for edge_id in incident_ids:
        edge = edges[edge_id]
        if not edge.alive:
            continue

        edge.alive = False
        outgoing_ids[edge.source].discard(edge_id)
        incoming_ids[edge.target].discard(edge_id)
        impacted.add(edge.source)
        impacted.add(edge.target)

    for replacement in merge_plan.replacements:
        new_edge_id = len(edges)
        edges.append(
            _MutableEdge(
                source=replacement.source_index,
                target=replacement.target_index,
                cost_seconds=replacement.cost_seconds,
                flags=replacement.flags,
            )
        )
        outgoing_ids[replacement.source_index].add(new_edge_id)
        incoming_ids[replacement.target_index].add(new_edge_id)
        impacted.add(replacement.source_index)
        impacted.add(replacement.target_index)

    removed_nodes[node_index] = True
    outgoing_ids[node_index].clear()
    incoming_ids[node_index].clear()
    impacted.discard(node_index)
    return impacted


def _reindex_graph(
    *,
    nodes: list[GraphNode],
    removed_nodes: list[bool],
    edges: list[_MutableEdge],
    skipped_constraint_way_count: int,
) -> AdjacencyGraph:
    old_to_new: dict[int, int] = {}
    new_nodes: list[GraphNode] = []

    for old_index, node in enumerate(nodes):
        if removed_nodes[old_index]:
            continue
        old_to_new[old_index] = len(new_nodes)
        new_nodes.append(replace(node, first_edge_index=0, edge_count=0))

    deduped_costs: dict[tuple[int, int, int], int] = {}

    for edge in edges:
        if not edge.alive:
            continue
        if edge.source not in old_to_new or edge.target not in old_to_new:
            continue

        source_index = old_to_new[edge.source]
        target_index = old_to_new[edge.target]
        key = (source_index, target_index, edge.flags)
        deduped_costs[key] = min(
            deduped_costs.get(key, edge.cost_seconds),
            min(edge.cost_seconds, MAX_EDGE_COST_SECONDS),
        )

    sorted_edges = sorted(
        deduped_costs.items(),
        key=lambda item: (item[0][0], item[0][1], item[0][2]),
    )
    new_edges = [
        GraphEdge(
            source_index=source,
            target_index=target,
            cost_seconds=cost,
            flags=flags,
        )
        for (source, target, flags), cost in sorted_edges
    ]

    i = 0
    while i < len(new_edges):
        source_index = new_edges[i].source_index
        j = i
        while j < len(new_edges) and new_edges[j].source_index == source_index:
            j += 1

        new_nodes[source_index] = replace(
            new_nodes[source_index],
            first_edge_index=i,
            edge_count=j - i,
        )
        i = j

    return AdjacencyGraph(
        nodes=tuple(new_nodes),
        edges=tuple(new_edges),
        skipped_constraint_way_count=skipped_constraint_way_count,
    )
