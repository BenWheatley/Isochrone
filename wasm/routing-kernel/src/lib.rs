use std::alloc::{alloc, dealloc, Layout};

const EDGE_MODE_WALK_BIT: u8 = 1;
const EDGE_MODE_BIKE_BIT: u8 = 1 << 1;
const EDGE_MODE_CAR_BIT: u8 = 1 << 2;
const ROAD_CLASS_MOTORWAY: u8 = 15;
const WALKING_SPEED_M_S: f32 = 1.4;
const BIKE_CRUISE_SPEED_KPH: f32 = 20.0;
const CAR_FALLBACK_SPEED_KPH: f32 = 30.0;

#[inline]
fn edge_cost_seconds(
    allowed_mode_mask: u8,
    edge_mode_mask: u8,
    road_class_id: u8,
    edge_maxspeed_kph: u16,
    walking_cost_seconds: u16,
) -> f32 {
    if (edge_mode_mask & allowed_mode_mask) == 0 || walking_cost_seconds == 0 {
        return f32::INFINITY;
    }

    let walking_cost_seconds_f32 = walking_cost_seconds as f32;
    let distance_m = (walking_cost_seconds_f32 * WALKING_SPEED_M_S).max(1.0);
    let maxspeed_kph = edge_maxspeed_kph as f32;
    let mut best_cost = f32::INFINITY;

    if (allowed_mode_mask & EDGE_MODE_WALK_BIT) != 0
        && (edge_mode_mask & EDGE_MODE_WALK_BIT) != 0
        && road_class_id != ROAD_CLASS_MOTORWAY
    {
        best_cost = best_cost.min(walking_cost_seconds_f32);
    }

    if (allowed_mode_mask & EDGE_MODE_BIKE_BIT) != 0
        && (edge_mode_mask & EDGE_MODE_BIKE_BIT) != 0
        && road_class_id != ROAD_CLASS_MOTORWAY
    {
        let bike_speed_kph = BIKE_CRUISE_SPEED_KPH.min(maxspeed_kph);
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
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn car_cost_uses_road_speed() {
        let cost = edge_cost_seconds(EDGE_MODE_CAR_BIT, EDGE_MODE_CAR_BIT, 11, 50, 72);
        assert!(cost.is_finite());
        assert!(cost > 0.0);
        assert!(cost < 72.0);
    }

    #[test]
    fn walk_disallows_motorway() {
        let cost = edge_cost_seconds(EDGE_MODE_WALK_BIT, EDGE_MODE_WALK_BIT, ROAD_CLASS_MOTORWAY, 50, 72);
        assert!(cost.is_infinite());
    }
}
