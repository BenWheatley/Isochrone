use std::alloc::{alloc, dealloc, Layout};
use std::cell::RefCell;

const EDGE_MODE_WALK_BIT: u8 = 1;
const EDGE_MODE_BIKE_BIT: u8 = 1 << 1;
const EDGE_MODE_CAR_BIT: u8 = 1 << 2;
const EDGE_MODE_WATER_BIT: u8 = 1 << 3;
const ROAD_CLASS_MOTORWAY: u8 = 15;
const WALKING_SPEED_M_S: f32 = 1.4;
const BIKE_CRUISE_SPEED_KPH: f32 = 20.0;
const CAR_FALLBACK_SPEED_KPH: f32 = 30.0;
const WATER_FALLBACK_SPEED_KPH: f32 = 25.0;
const COST_TICK_SCALE: f32 = 1_000.0;
const RADIX_BUCKET_COUNT: usize = 33;

struct RadixHeap {
    buckets: Vec<Vec<(u32, u32)>>,
    bucket_min_keys: [u32; RADIX_BUCKET_COUNT],
    last: u32,
    len: usize,
}

impl RadixHeap {
    fn with_capacity(capacity: usize) -> Self {
        let mut buckets = Vec::with_capacity(RADIX_BUCKET_COUNT);
        for _ in 0..RADIX_BUCKET_COUNT {
            buckets.push(Vec::new());
        }
        buckets[0].reserve(capacity);
        Self {
            buckets,
            bucket_min_keys: [u32::MAX; RADIX_BUCKET_COUNT],
            last: 0,
            len: 0,
        }
    }

    fn is_empty(&self) -> bool {
        self.len == 0
    }

    fn push(&mut self, node_index: u32, key: u32) {
        debug_assert!(key >= self.last);
        let bucket_index = Self::bucket_index(key, self.last);
        self.buckets[bucket_index].push((node_index, key));
        if key < self.bucket_min_keys[bucket_index] {
            self.bucket_min_keys[bucket_index] = key;
        }
        self.len += 1;
    }

    fn pop(&mut self) -> Option<(u32, u32)> {
        if self.len == 0 {
            return None;
        }
        if self.buckets[0].is_empty() {
            self.refill_bucket_zero();
        }

        let entry = self.buckets[0].pop();
        if let Some(_entry) = entry {
            self.len -= 1;
            if self.buckets[0].is_empty() {
                self.bucket_min_keys[0] = u32::MAX;
            }
            return Some(_entry);
        }
        None
    }

    fn bucket_index(key: u32, last: u32) -> usize {
        if key == last {
            0
        } else {
            (u32::BITS - (key ^ last).leading_zeros()) as usize
        }
    }

    fn refill_bucket_zero(&mut self) {
        let mut non_empty_index = 1usize;
        while non_empty_index < self.buckets.len()
            && self.bucket_min_keys[non_empty_index] == u32::MAX
        {
            non_empty_index += 1;
        }
        if non_empty_index >= self.buckets.len() {
            return;
        }

        self.last = self.bucket_min_keys[non_empty_index];

        let mut moved_entries = Vec::new();
        std::mem::swap(&mut moved_entries, &mut self.buckets[non_empty_index]);
        self.bucket_min_keys[non_empty_index] = u32::MAX;
        for (node_index, key) in moved_entries {
            let bucket_index = Self::bucket_index(key, self.last);
            self.buckets[bucket_index].push((node_index, key));
            if key < self.bucket_min_keys[bucket_index] {
                self.bucket_min_keys[bucket_index] = key;
            }
        }
    }

    fn clear_with_capacity_hint(&mut self, capacity_hint: usize) {
        for bucket in self.buckets.iter_mut() {
            bucket.clear();
        }
        self.bucket_min_keys.fill(u32::MAX);
        if let Some(bucket_zero) = self.buckets.get_mut(0) {
            let additional = capacity_hint.saturating_sub(bucket_zero.capacity());
            if additional > 0 {
                bucket_zero.reserve(additional);
            }
        }
        self.last = 0;
        self.len = 0;
    }
}

struct SearchWorkspace {
    dist_ticks: Vec<u32>,
    settled: Vec<u8>,
    heap: RadixHeap,
}

impl SearchWorkspace {
    fn new() -> Self {
        Self {
            dist_ticks: Vec::new(),
            settled: Vec::new(),
            heap: RadixHeap::with_capacity(0),
        }
    }

    fn prepare_for_search(&mut self, node_count: usize, heap_capacity_hint: usize) {
        if self.dist_ticks.len() < node_count {
            self.dist_ticks.resize(node_count, u32::MAX);
        } else {
            self.dist_ticks[..node_count].fill(u32::MAX);
        }

        if self.settled.len() < node_count {
            self.settled.resize(node_count, 0);
        } else {
            self.settled[..node_count].fill(0);
        }

        self.heap.clear_with_capacity_hint(heap_capacity_hint);
    }
}

thread_local! {
    static SEARCH_WORKSPACE: RefCell<SearchWorkspace> = RefCell::new(SearchWorkspace::new());
}

#[inline]
fn edge_cost_seconds(
    allowed_mode_mask: u8,
    edge_mode_mask: u8,
    road_class_id: u8,
    edge_maxspeed_kph: u16,
    walking_cost_seconds: u16,
    walking_speed_m_s: f32,
    bike_cruise_speed_kph: f32,
) -> f32 {
    if (edge_mode_mask & allowed_mode_mask) == 0 || walking_cost_seconds == 0 {
        return f32::INFINITY;
    }

    let walking_cost_seconds_f32 = walking_cost_seconds as f32;
    // distance_m is reconstructed from the graph's baked-in walking cost
    // using the build-time WALKING_SPEED_M_S constant (the speed the data
    // pipeline actually assumed when it computed walking_cost_seconds from
    // real edge geometry) — not the caller's walking_speed_m_s parameter,
    // which is a user preference applied only to the walk-mode cost below.
    // Using the user's speed here would corrupt the physical distance that
    // bike/car/water costs derive from.
    let distance_m = (walking_cost_seconds_f32 * WALKING_SPEED_M_S).max(1.0);
    let maxspeed_kph = edge_maxspeed_kph as f32;

    if (edge_mode_mask & EDGE_MODE_WATER_BIT) != 0 {
        // A ferry leg's crossing time doesn't depend on which boarding bit
        // (walk/bike/car) matched allowed_mode_mask — always cost it at the
        // baked ferry speed (duration-tag-derived, explicit maxspeed, or the
        // flat fallback, already resolved at build time into edge_maxspeed_kph).
        let water_speed_kph = if maxspeed_kph > 0.0 {
            maxspeed_kph
        } else {
            WATER_FALLBACK_SPEED_KPH
        };
        if water_speed_kph <= 0.0 {
            return f32::INFINITY;
        }
        return distance_m / (water_speed_kph * (1000.0 / 3600.0));
    }

    let mut best_cost = f32::INFINITY;

    if (allowed_mode_mask & EDGE_MODE_WALK_BIT) != 0
        && (edge_mode_mask & EDGE_MODE_WALK_BIT) != 0
        && road_class_id != ROAD_CLASS_MOTORWAY
    {
        if walking_speed_m_s > 0.0 {
            best_cost = best_cost.min(distance_m / walking_speed_m_s);
        } else {
            best_cost = best_cost.min(walking_cost_seconds_f32);
        }
    }

    if (allowed_mode_mask & EDGE_MODE_BIKE_BIT) != 0
        && (edge_mode_mask & EDGE_MODE_BIKE_BIT) != 0
        && road_class_id != ROAD_CLASS_MOTORWAY
    {
        let bike_speed_kph = bike_cruise_speed_kph.min(maxspeed_kph);
        if bike_speed_kph > 0.0 {
            best_cost = best_cost.min(distance_m / (bike_speed_kph * (1000.0 / 3600.0)));
        }
    }

    if (allowed_mode_mask & EDGE_MODE_CAR_BIT) != 0 && (edge_mode_mask & EDGE_MODE_CAR_BIT) != 0 {
        let car_speed_kph = if maxspeed_kph > 0.0 {
            maxspeed_kph
        } else {
            CAR_FALLBACK_SPEED_KPH
        };
        if car_speed_kph > 0.0 {
            best_cost = best_cost.min(distance_m / (car_speed_kph * (1000.0 / 3600.0)));
        }
    }

    best_cost
}

#[inline]
fn quantize_seconds_to_ticks(seconds: f32) -> Option<u32> {
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }

    let scaled = (seconds as f64) * (COST_TICK_SCALE as f64);
    if !scaled.is_finite() || scaled <= 0.0 {
        return None;
    }

    let ticks = scaled.ceil();
    if ticks >= u32::MAX as f64 {
        Some(u32::MAX)
    } else {
        Some(ticks as u32)
    }
}

#[inline]
fn ticks_to_seconds(ticks: u32) -> f32 {
    (ticks as f32) / COST_TICK_SCALE
}

/// `seeds` are (node_index, start_ticks) pairs. A single-source search is
/// just the one-element case; RadixHeap::push has no source-count
/// assumption (its `key >= self.last` invariant holds for any push order
/// since `last` starts at 0), so seeding multiple sources up front before
/// the pop loop begins is sufficient for correct multi-source Dijkstra.
#[inline]
fn run_travel_time_field_with_workspace(
    workspace: &mut SearchWorkspace,
    out_dist_seconds: &mut [f32],
    node_first_edge_index: &[u32],
    node_edge_count: &[u16],
    edge_target_node_index: &[u32],
    edge_cost_ticks: &[u32],
    seeds: &[(u32, u32)],
    has_time_limit: bool,
    clamped_time_limit_ticks: u32,
) -> u32 {
    let node_count = out_dist_seconds.len();
    let edge_count = edge_target_node_index.len();
    workspace.prepare_for_search(node_count, node_count.min(16_384));

    for &(seed_node_index, seed_start_ticks) in seeds {
        let seed_index = seed_node_index as usize;
        if seed_index >= node_count {
            continue;
        }
        if seed_start_ticks < workspace.dist_ticks[seed_index] {
            workspace.dist_ticks[seed_index] = seed_start_ticks;
            workspace.heap.push(seed_node_index, seed_start_ticks);
        }
    }

    let mut settled_count = 0u32;

    while !workspace.heap.is_empty() {
        let Some((node_index_u32, cost_ticks)) = workspace.heap.pop() else {
            break;
        };
        let node_index = node_index_u32 as usize;
        if node_index >= node_count {
            continue;
        }
        if cost_ticks > workspace.dist_ticks[node_index] {
            continue;
        }
        if has_time_limit && cost_ticks > clamped_time_limit_ticks {
            break;
        }
        if workspace.settled[node_index] == 1 {
            continue;
        }

        workspace.settled[node_index] = 1;
        settled_count = settled_count.saturating_add(1);

        let first_edge_index = node_first_edge_index[node_index] as usize;
        if first_edge_index >= edge_count {
            continue;
        }
        let edge_span = node_edge_count[node_index] as usize;
        let end_edge_index = first_edge_index.saturating_add(edge_span).min(edge_count);

        for edge_index in first_edge_index..end_edge_index {
            let edge_ticks = edge_cost_ticks[edge_index];
            if edge_ticks == 0 {
                continue;
            }

            let target_node_index = edge_target_node_index[edge_index] as usize;
            if target_node_index >= node_count {
                continue;
            }
            if workspace.settled[target_node_index] == 1 {
                continue;
            }

            let next_cost_ticks = cost_ticks.saturating_add(edge_ticks);
            if has_time_limit && next_cost_ticks > clamped_time_limit_ticks {
                continue;
            }
            if next_cost_ticks < workspace.dist_ticks[target_node_index] {
                workspace.dist_ticks[target_node_index] = next_cost_ticks;
                workspace.heap.push(target_node_index as u32, next_cost_ticks);
            }
        }
    }

    for index in 0..node_count {
        let ticks = workspace.dist_ticks[index];
        out_dist_seconds[index] = if ticks == u32::MAX {
            f32::INFINITY
        } else {
            ticks_to_seconds(ticks)
        };
    }

    settled_count
}

#[no_mangle]
pub extern "C" fn wasm_alloc(size_bytes: usize) -> *mut u8 {
    if size_bytes == 0 {
        return std::ptr::null_mut();
    }

    let Ok(layout) = Layout::from_size_align(size_bytes, 8) else {
        return std::ptr::null_mut();
    };

    unsafe { alloc(layout) }
}

#[no_mangle]
pub extern "C" fn wasm_dealloc(ptr: *mut u8, size_bytes: usize) {
    if ptr.is_null() || size_bytes == 0 {
        return;
    }

    let Ok(layout) = Layout::from_size_align(size_bytes, 8) else {
        return;
    };

    unsafe { dealloc(ptr, layout) };
}

#[no_mangle]
pub extern "C" fn precompute_edge_costs(
    out_cost_seconds_ptr: *mut f32,
    edge_mode_mask_ptr: *const u8,
    edge_road_class_ptr: *const u8,
    edge_maxspeed_kph_ptr: *const u16,
    edge_walk_cost_seconds_ptr: *const u16,
    edge_count: usize,
    allowed_mode_mask: u8,
    walking_speed_m_s: f32,
    bike_cruise_speed_kph: f32,
) {
    if out_cost_seconds_ptr.is_null()
        || edge_mode_mask_ptr.is_null()
        || edge_road_class_ptr.is_null()
        || edge_maxspeed_kph_ptr.is_null()
        || edge_walk_cost_seconds_ptr.is_null()
        || edge_count == 0
    {
        return;
    }

    let resolved_walking_speed_m_s = if walking_speed_m_s.is_finite() && walking_speed_m_s > 0.0 {
        walking_speed_m_s
    } else {
        WALKING_SPEED_M_S
    };
    let resolved_bike_cruise_speed_kph =
        if bike_cruise_speed_kph.is_finite() && bike_cruise_speed_kph > 0.0 {
            bike_cruise_speed_kph
        } else {
            BIKE_CRUISE_SPEED_KPH
        };

    let out_costs = unsafe { std::slice::from_raw_parts_mut(out_cost_seconds_ptr, edge_count) };
    let edge_mode_mask = unsafe { std::slice::from_raw_parts(edge_mode_mask_ptr, edge_count) };
    let edge_road_class = unsafe { std::slice::from_raw_parts(edge_road_class_ptr, edge_count) };
    let edge_maxspeed_kph = unsafe { std::slice::from_raw_parts(edge_maxspeed_kph_ptr, edge_count) };
    let edge_walk_cost_seconds =
        unsafe { std::slice::from_raw_parts(edge_walk_cost_seconds_ptr, edge_count) };

    for index in 0..edge_count {
        out_costs[index] = edge_cost_seconds(
            allowed_mode_mask,
            edge_mode_mask[index],
            edge_road_class[index],
            edge_maxspeed_kph[index],
            edge_walk_cost_seconds[index],
            resolved_walking_speed_m_s,
            resolved_bike_cruise_speed_kph,
        );
    }
}

#[no_mangle]
pub extern "C" fn compute_travel_time_field(
    out_dist_seconds_ptr: *mut f32,
    node_first_edge_index_ptr: *const u32,
    node_edge_count_ptr: *const u16,
    node_count: usize,
    edge_target_node_index_ptr: *const u32,
    edge_cost_ticks_ptr: *const u32,
    edge_count: usize,
    source_node_index: u32,
    time_limit_seconds: f32,
) -> u32 {
    if out_dist_seconds_ptr.is_null()
        || node_first_edge_index_ptr.is_null()
        || node_edge_count_ptr.is_null()
        || node_count == 0
        || (edge_count > 0
            && (edge_target_node_index_ptr.is_null()
                || edge_cost_ticks_ptr.is_null()))
    {
        return 0;
    }

    let out_dist_seconds = unsafe { std::slice::from_raw_parts_mut(out_dist_seconds_ptr, node_count) };
    let node_first_edge_index =
        unsafe { std::slice::from_raw_parts(node_first_edge_index_ptr, node_count) };
    let node_edge_count = unsafe { std::slice::from_raw_parts(node_edge_count_ptr, node_count) };
    let edge_target_node_index = if edge_count > 0 {
        unsafe { std::slice::from_raw_parts(edge_target_node_index_ptr, edge_count) }
    } else {
        &[]
    };
    let edge_cost_ticks = if edge_count > 0 {
        unsafe { std::slice::from_raw_parts(edge_cost_ticks_ptr, edge_count) }
    } else {
        &[]
    };

    for dist in out_dist_seconds.iter_mut() {
        *dist = f32::INFINITY;
    }

    let source_index = source_node_index as usize;
    if source_index >= node_count {
        return 0;
    }
    let seeds = [(source_node_index, 0u32)];

    let has_time_limit = time_limit_seconds.is_finite() && time_limit_seconds > 0.0;
    let clamped_time_limit_ticks = if has_time_limit {
        quantize_seconds_to_ticks(time_limit_seconds).unwrap_or(u32::MAX)
    } else {
        u32::MAX
    };

    let mut settled_count = 0u32;
    let mut used_cached_workspace = false;

    SEARCH_WORKSPACE.with(|workspace_cell| {
        if let Ok(mut workspace) = workspace_cell.try_borrow_mut() {
            settled_count = run_travel_time_field_with_workspace(
                &mut workspace,
                out_dist_seconds,
                node_first_edge_index,
                node_edge_count,
                edge_target_node_index,
                edge_cost_ticks,
                &seeds,
                has_time_limit,
                clamped_time_limit_ticks,
            );
            used_cached_workspace = true;
        }
    });

    if !used_cached_workspace {
        let mut fallback_workspace = SearchWorkspace::new();
        settled_count = run_travel_time_field_with_workspace(
            &mut fallback_workspace,
            out_dist_seconds,
            node_first_edge_index,
            node_edge_count,
            edge_target_node_index,
            edge_cost_ticks,
            &seeds,
            has_time_limit,
            clamped_time_limit_ticks,
        );
    }

    settled_count
}

#[inline]
fn seconds_to_start_ticks(seconds: f32) -> u32 {
    // Unlike edge costs (which must be strictly positive to advance the
    // search), a seed's start distance is legitimately 0 (the walking
    // origin) or any non-negative value (a transit-reached stop's elapsed
    // arrival time) — quantize_seconds_to_ticks rejects <= 0.0 outright,
    // so 0 is handled separately here.
    if !seconds.is_finite() || seconds <= 0.0 {
        0
    } else {
        quantize_seconds_to_ticks(seconds).unwrap_or(u32::MAX)
    }
}

/// Multi-source variant of compute_travel_time_field: seeds the search from
/// every (seed_node_indices[i], seed_start_dist_seconds[i]) pair instead of
/// a single scalar source. Used for the post-CSA reseed pass — walking
/// Dijkstra from the origin plus every transit-reached stop, all in one
/// pass, so the result is already the walk-vs-walk+transit+walk minimum
/// with no separate merge step needed.
#[no_mangle]
pub extern "C" fn compute_travel_time_field_multi_source(
    out_dist_seconds_ptr: *mut f32,
    node_first_edge_index_ptr: *const u32,
    node_edge_count_ptr: *const u16,
    node_count: usize,
    edge_target_node_index_ptr: *const u32,
    edge_cost_ticks_ptr: *const u32,
    edge_count: usize,
    seed_node_indices_ptr: *const u32,
    seed_start_dist_seconds_ptr: *const f32,
    seed_count: usize,
    time_limit_seconds: f32,
) -> u32 {
    if out_dist_seconds_ptr.is_null()
        || node_first_edge_index_ptr.is_null()
        || node_edge_count_ptr.is_null()
        || node_count == 0
        || (edge_count > 0
            && (edge_target_node_index_ptr.is_null() || edge_cost_ticks_ptr.is_null()))
        || (seed_count > 0
            && (seed_node_indices_ptr.is_null() || seed_start_dist_seconds_ptr.is_null()))
    {
        return 0;
    }

    let out_dist_seconds =
        unsafe { std::slice::from_raw_parts_mut(out_dist_seconds_ptr, node_count) };
    let node_first_edge_index =
        unsafe { std::slice::from_raw_parts(node_first_edge_index_ptr, node_count) };
    let node_edge_count = unsafe { std::slice::from_raw_parts(node_edge_count_ptr, node_count) };
    let edge_target_node_index = if edge_count > 0 {
        unsafe { std::slice::from_raw_parts(edge_target_node_index_ptr, edge_count) }
    } else {
        &[]
    };
    let edge_cost_ticks = if edge_count > 0 {
        unsafe { std::slice::from_raw_parts(edge_cost_ticks_ptr, edge_count) }
    } else {
        &[]
    };
    let seed_node_indices = if seed_count > 0 {
        unsafe { std::slice::from_raw_parts(seed_node_indices_ptr, seed_count) }
    } else {
        &[]
    };
    let seed_start_dist_seconds = if seed_count > 0 {
        unsafe { std::slice::from_raw_parts(seed_start_dist_seconds_ptr, seed_count) }
    } else {
        &[]
    };

    for dist in out_dist_seconds.iter_mut() {
        *dist = f32::INFINITY;
    }

    if seed_count == 0 {
        return 0;
    }

    let seeds: Vec<(u32, u32)> = seed_node_indices
        .iter()
        .zip(seed_start_dist_seconds.iter())
        .map(|(&node_index, &start_seconds)| (node_index, seconds_to_start_ticks(start_seconds)))
        .collect();

    let has_time_limit = time_limit_seconds.is_finite() && time_limit_seconds > 0.0;
    let clamped_time_limit_ticks = if has_time_limit {
        quantize_seconds_to_ticks(time_limit_seconds).unwrap_or(u32::MAX)
    } else {
        u32::MAX
    };

    let mut settled_count = 0u32;
    let mut used_cached_workspace = false;

    SEARCH_WORKSPACE.with(|workspace_cell| {
        if let Ok(mut workspace) = workspace_cell.try_borrow_mut() {
            settled_count = run_travel_time_field_with_workspace(
                &mut workspace,
                out_dist_seconds,
                node_first_edge_index,
                node_edge_count,
                edge_target_node_index,
                edge_cost_ticks,
                &seeds,
                has_time_limit,
                clamped_time_limit_ticks,
            );
            used_cached_workspace = true;
        }
    });

    if !used_cached_workspace {
        let mut fallback_workspace = SearchWorkspace::new();
        settled_count = run_travel_time_field_with_workspace(
            &mut fallback_workspace,
            out_dist_seconds,
            node_first_edge_index,
            node_edge_count,
            edge_target_node_index,
            edge_cost_ticks,
            &seeds,
            has_time_limit,
            clamped_time_limit_ticks,
        );
    }

    settled_count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantize_seconds_to_ticks_uses_positive_ceil() {
        assert_eq!(quantize_seconds_to_ticks(0.0), None);
        assert_eq!(quantize_seconds_to_ticks(-1.0), None);
        assert_eq!(quantize_seconds_to_ticks(f32::INFINITY), None);
        assert_eq!(quantize_seconds_to_ticks(0.0001), Some(1));
        assert_eq!(quantize_seconds_to_ticks(1.0), Some(1_000));
        assert_eq!(quantize_seconds_to_ticks(1.0001), Some(1_001));
    }

    #[test]
    fn radix_heap_returns_non_decreasing_keys() {
        let mut heap = RadixHeap::with_capacity(8);
        heap.push(5, 50);
        heap.push(2, 20);
        heap.push(4, 40);
        heap.push(3, 30);
        heap.push(1, 10);

        let mut keys = Vec::new();
        while let Some((_node, key)) = heap.pop() {
            keys.push(key);
        }

        assert_eq!(keys, vec![10, 20, 30, 40, 50]);
    }

    #[test]
    fn radix_heap_handles_interleaved_push_pop_cycles() {
        let mut heap = RadixHeap::with_capacity(4);
        heap.push(1, 1_000);
        heap.push(2, 2_000);
        assert_eq!(heap.pop(), Some((1, 1_000)));
        heap.push(3, 2_000);
        heap.push(4, 3_000);
        assert_eq!(heap.pop(), Some((3, 2_000)));
        assert_eq!(heap.pop(), Some((2, 2_000)));
        assert_eq!(heap.pop(), Some((4, 3_000)));
        assert_eq!(heap.pop(), None);
    }

    #[test]
    fn compute_travel_time_field_respects_shortest_path_with_quantization() {
        let node_first_edge_index = [0u32, 2, 3];
        let node_edge_count = [2u16, 1, 0];
        let edge_target_node_index = [1u32, 2, 2];
        let edge_cost_ticks = [10_000u32, 25_000u32, 10_000u32];
        let mut out_dist_seconds = [f32::INFINITY; 3];

        let settled_count = compute_travel_time_field(
            out_dist_seconds.as_mut_ptr(),
            node_first_edge_index.as_ptr(),
            node_edge_count.as_ptr(),
            3,
            edge_target_node_index.as_ptr(),
            edge_cost_ticks.as_ptr(),
            3,
            0,
            f32::INFINITY,
        );

        assert_eq!(settled_count, 3);
        assert_eq!(out_dist_seconds[0], 0.0);
        assert_eq!(out_dist_seconds[1], 10.0);
        assert_eq!(out_dist_seconds[2], 20.0);
    }

    #[test]
    fn compute_travel_time_field_resets_workspace_between_calls() {
        let node_first_edge_index = [0u32, 2, 3];
        let node_edge_count = [2u16, 1, 0];
        let edge_target_node_index = [1u32, 2, 2];
        let edge_cost_ticks = [10_000u32, 25_000u32, 10_000u32];
        let mut out_dist_seconds = [f32::INFINITY; 3];

        let first_settled = compute_travel_time_field(
            out_dist_seconds.as_mut_ptr(),
            node_first_edge_index.as_ptr(),
            node_edge_count.as_ptr(),
            3,
            edge_target_node_index.as_ptr(),
            edge_cost_ticks.as_ptr(),
            3,
            0,
            f32::INFINITY,
        );
        assert_eq!(first_settled, 3);
        assert_eq!(out_dist_seconds, [0.0, 10.0, 20.0]);

        let second_settled = compute_travel_time_field(
            out_dist_seconds.as_mut_ptr(),
            node_first_edge_index.as_ptr(),
            node_edge_count.as_ptr(),
            3,
            edge_target_node_index.as_ptr(),
            edge_cost_ticks.as_ptr(),
            3,
            1,
            f32::INFINITY,
        );
        assert_eq!(second_settled, 2);
        assert_eq!(out_dist_seconds[0], f32::INFINITY);
        assert_eq!(out_dist_seconds[1], 0.0);
        assert_eq!(out_dist_seconds[2], 10.0);
    }

    #[test]
    fn car_cost_uses_road_speed() {
        let cost = edge_cost_seconds(EDGE_MODE_CAR_BIT, EDGE_MODE_CAR_BIT, 11, 50, 72, WALKING_SPEED_M_S, BIKE_CRUISE_SPEED_KPH);
        assert!(cost.is_finite());
        assert!(cost > 0.0);
        assert!(cost < 72.0);
    }

    #[test]
    fn custom_walking_speed_rescales_walk_cost() {
        let default_cost =
            edge_cost_seconds(EDGE_MODE_WALK_BIT, EDGE_MODE_WALK_BIT, 0, 0, 72, WALKING_SPEED_M_S, BIKE_CRUISE_SPEED_KPH);
        assert!((default_cost - 72.0).abs() < 0.01);

        let faster_cost = edge_cost_seconds(
            EDGE_MODE_WALK_BIT,
            EDGE_MODE_WALK_BIT,
            0,
            0,
            72,
            WALKING_SPEED_M_S * 2.0,
            BIKE_CRUISE_SPEED_KPH,
        );
        assert!((faster_cost - default_cost / 2.0).abs() < 0.01);
    }

    #[test]
    fn custom_bike_speed_rescales_bike_cost() {
        let default_cost =
            edge_cost_seconds(EDGE_MODE_BIKE_BIT, EDGE_MODE_BIKE_BIT, 0, 50, 72, WALKING_SPEED_M_S, BIKE_CRUISE_SPEED_KPH);
        let faster_cost = edge_cost_seconds(
            EDGE_MODE_BIKE_BIT,
            EDGE_MODE_BIKE_BIT,
            0,
            50,
            72,
            WALKING_SPEED_M_S,
            BIKE_CRUISE_SPEED_KPH * 2.0,
        );
        assert!(faster_cost < default_cost);
        assert!((faster_cost - default_cost / 2.0).abs() < 0.01);
    }

    #[test]
    fn walk_disallows_motorway() {
        let cost = edge_cost_seconds(EDGE_MODE_WALK_BIT, EDGE_MODE_WALK_BIT, ROAD_CLASS_MOTORWAY, 50, 72, WALKING_SPEED_M_S, BIKE_CRUISE_SPEED_KPH);
        assert!(cost.is_infinite());
    }

    #[test]
    fn water_cost_ignores_boarding_mode_and_uses_baked_speed() {
        let edge_mode_mask = EDGE_MODE_WALK_BIT | EDGE_MODE_WATER_BIT;
        let walk_cost = edge_cost_seconds(EDGE_MODE_WALK_BIT, edge_mode_mask, 0, 36, 72, WALKING_SPEED_M_S, BIKE_CRUISE_SPEED_KPH);
        let water_cost = edge_cost_seconds(EDGE_MODE_WATER_BIT, edge_mode_mask, 0, 36, 72, WALKING_SPEED_M_S, BIKE_CRUISE_SPEED_KPH);
        assert!(walk_cost.is_finite());
        assert_eq!(walk_cost, water_cost);
        // Ferry pace (36 kph), not walking pace (WALKING_SPEED_M_S).
        assert!(walk_cost < 72.0);

        let bike_cost = edge_cost_seconds(EDGE_MODE_BIKE_BIT, edge_mode_mask, 0, 36, 72, WALKING_SPEED_M_S, BIKE_CRUISE_SPEED_KPH);
        assert!(bike_cost.is_infinite());
    }

    #[test]
    fn multi_source_with_one_seed_matches_single_source() {
        let node_first_edge_index = [0u32, 2, 3];
        let node_edge_count = [2u16, 1, 0];
        let edge_target_node_index = [1u32, 2, 2];
        let edge_cost_ticks = [10_000u32, 25_000u32, 10_000u32];

        let mut single_source_out = [f32::INFINITY; 3];
        compute_travel_time_field(
            single_source_out.as_mut_ptr(),
            node_first_edge_index.as_ptr(),
            node_edge_count.as_ptr(),
            3,
            edge_target_node_index.as_ptr(),
            edge_cost_ticks.as_ptr(),
            3,
            0,
            f32::INFINITY,
        );

        let seed_node_indices = [0u32];
        let seed_start_dist_seconds = [0.0f32];
        let mut multi_source_out = [f32::INFINITY; 3];
        let settled_count = compute_travel_time_field_multi_source(
            multi_source_out.as_mut_ptr(),
            node_first_edge_index.as_ptr(),
            node_edge_count.as_ptr(),
            3,
            edge_target_node_index.as_ptr(),
            edge_cost_ticks.as_ptr(),
            3,
            seed_node_indices.as_ptr(),
            seed_start_dist_seconds.as_ptr(),
            1,
            f32::INFINITY,
        );

        assert_eq!(settled_count, 3);
        assert_eq!(multi_source_out, single_source_out);
    }

    #[test]
    fn multi_source_seed_shortcuts_a_downstream_node() {
        // Same graph as above (0 -> 1 costs 10s, 0 -> 2 costs 25s directly,
        // 1 -> 2 costs 10s, so pure walking reaches node 2 at t=20s via
        // node 1). Seeding node 2 directly at t=5s (as if a transit ride
        // got there faster) must win over the walked 20s path, and must
        // not affect node 1 (no edge runs from node 2 back to node 1).
        let node_first_edge_index = [0u32, 2, 3];
        let node_edge_count = [2u16, 1, 0];
        let edge_target_node_index = [1u32, 2, 2];
        let edge_cost_ticks = [10_000u32, 25_000u32, 10_000u32];

        let seed_node_indices = [0u32, 2u32];
        let seed_start_dist_seconds = [0.0f32, 5.0f32];
        let mut out_dist_seconds = [f32::INFINITY; 3];
        let settled_count = compute_travel_time_field_multi_source(
            out_dist_seconds.as_mut_ptr(),
            node_first_edge_index.as_ptr(),
            node_edge_count.as_ptr(),
            3,
            edge_target_node_index.as_ptr(),
            edge_cost_ticks.as_ptr(),
            3,
            seed_node_indices.as_ptr(),
            seed_start_dist_seconds.as_ptr(),
            2,
            f32::INFINITY,
        );

        assert_eq!(settled_count, 3);
        assert_eq!(out_dist_seconds[0], 0.0);
        assert_eq!(out_dist_seconds[1], 10.0);
        assert_eq!(out_dist_seconds[2], 5.0);
    }

    #[test]
    fn multi_source_with_zero_seeds_settles_nothing() {
        let node_first_edge_index = [0u32, 2, 3];
        let node_edge_count = [2u16, 1, 0];
        let edge_target_node_index = [1u32, 2, 2];
        let edge_cost_ticks = [10_000u32, 25_000u32, 10_000u32];
        let mut out_dist_seconds = [0.0f32; 3];

        let settled_count = compute_travel_time_field_multi_source(
            out_dist_seconds.as_mut_ptr(),
            node_first_edge_index.as_ptr(),
            node_edge_count.as_ptr(),
            3,
            edge_target_node_index.as_ptr(),
            edge_cost_ticks.as_ptr(),
            3,
            std::ptr::null(),
            std::ptr::null(),
            0,
            f32::INFINITY,
        );

        assert_eq!(settled_count, 0);
        assert!(out_dist_seconds.iter().all(|dist| dist.is_infinite()));
    }

    #[test]
    fn water_cost_falls_back_without_baked_maxspeed() {
        let cost = edge_cost_seconds(EDGE_MODE_WATER_BIT, EDGE_MODE_WATER_BIT, 0, 0, 72, WALKING_SPEED_M_S, BIKE_CRUISE_SPEED_KPH);
        assert!(cost.is_finite());
        let distance_m = 72.0_f32 * WALKING_SPEED_M_S;
        let expected = distance_m / (WATER_FALLBACK_SPEED_KPH * (1000.0 / 3600.0));
        assert!((cost - expected).abs() < 1e-3);
    }
}
