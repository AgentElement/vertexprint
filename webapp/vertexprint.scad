// The js script sets all of these global variables with the -D flag
// Values here are defaults.
EDGE_DIAMETER = 3.0;
DIAMETER_TOLERANCE_FIT = 0.35;
DIAMETER_TAPER_DECREASE = 0.10;
WALL_THICKNESS = 1.2;
RADIUS = 200;
ROD_INSET = 8;
MIN_PRINTER_OVERHANG_ANGLE = 30;

LABEL_VERTICES=false;
TUBULAR_SUPPORTS=true;

TUBE_DEPTH = ROD_INSET+WALL_THICKNESS;
OUTER_TUBE_RADIUS = EDGE_DIAMETER/2+WALL_THICKNESS;

INDEX = 0;

// Openscad hangs if you don't set these lists with a flag
vertex_figure = [];
vertex_figure_edge = [];
tag = "";
index = 0.0;
offsets = [];


// Locus of lowest points along a cylinder. v is axis, r is radius, l is parameter
function lowest_line_on_cylinder(v, l, r) =
    let(
        uv = v / norm(v),
        center = uv * l,
        down = [0, 0, -1],
        proj = down - (down * uv) * uv
    )
    (norm(proj) < 1e-9)
        ? center + [r, 0, 0]
        : center + r * (proj / norm(proj));

// Convert a unit vector to euler angles
function direction_to_euler(v) =
    [
        0,
        atan2(norm([v[0], v[1]]), v[2]),
        atan2(v[1], v[0])
    ];

// Calculates the smallest translation length l such that the outer cylinders (radius R)
// just touch the inner cylinders (radius r).
function axis_offset(v0, v1, R, r) =
    let(
        c = v0 * v1,
        s = norm(cross(v0, v1)),

        // Mode 1: Rim of outer contacts side of inner (active for acute angles)
        l_side = (R * c + r) / s,

        // Mode 2: Rim of inner touches base of outer (active for obtuse angles)
        // Uses identity cot(theta/2) = (1 + cos theta) / sin theta
        l_base = (r * (1 + c)) / s
    )
    // Handle parallel case to avoid division by zero
    s < 1e-9 ? (c > 0 ? 1e9 : 0) :
    max(l_side, l_base);


// Find the vector most aligned with -z (lowest vector)
function lowest_vector(vecs) =
    let(
        z_components = [for(v=vecs) v[2]],
        min_z = min(z_components),
        min_ix = search(min_z, z_components)[0]
    )
    min_ix;

// Return the vector with minimum cosine distance to t; assume that t = vecs[0]
function min_cos_dist(index, vecs) =
    let (
        scores = [for(i=[1:len(vecs)-1])
            i == index ?
                -1000 :
                (vecs[index] * vecs[i]) / norm(vecs[i])],
        ix = search(max(scores), scores)[0]
    )
    vecs[ix+1];

// Height to translate the vertex holder before making the xy cut
function offset_from_single_vec(index, vecs) =
    let ( closest = min_cos_dist(index, vecs) )
    axis_offset(vecs[index], closest, OUTER_TUBE_RADIUS, EDGE_DIAMETER/2);

// Concat two lists of vectors, but keep only their z-components
function concat_z(l1, l2) = [for(l=[l1, l2], a=l) a.z];

function cutoff_height(vecs, offsets) =
    let (
        lowest_bottom_points = [for (i=[0:len(vecs)-1])
            lowest_line_on_cylinder(vecs[i], offsets[i], OUTER_TUBE_RADIUS)],
        lowest_top_points = [for (i=[0:len(vecs)-1])
            lowest_line_on_cylinder(vecs[i], offsets[i] + TUBE_DEPTH, OUTER_TUBE_RADIUS)],
        z_components = concat_z(lowest_bottom_points, lowest_top_points),
        lowest_point = min(z_components)
    )
    lowest_point;

module tubular_vertex_holder(vecs, offsets=[], edge_list=[], index) {
    offsets = len(offsets) == 0 ?
        [for (i=[0:len(vecs)-1]) offset_from_single_vec(i, vecs)] :
        offsets;

    vertex_offset = max(offsets);

    cutoff = cutoff_height(vecs, offsets);

    difference() {
        for(i=[0:len(vecs)-1]) {
            v = vecs[i];
            rotation = direction_to_euler(v);
            half_edge_offset = offsets[i];

            // Add support structure if v sits below the minimum overhang angle
            if (rotation[1] > 90 - MIN_PRINTER_OVERHANG_ANGLE && TUBULAR_SUPPORTS) {
                lowest_top_point = lowest_line_on_cylinder(
                    v,
                    half_edge_offset+TUBE_DEPTH,
                    OUTER_TUBE_RADIUS);

                base_inset =
                    abs(lowest_top_point.z - cutoff)
                    / tan(MIN_PRINTER_OVERHANG_ANGLE);

                clamped_base_position = min(
                    max(half_edge_offset + TUBE_DEPTH - base_inset, 0),
                    norm([lowest_top_point.x, lowest_top_point.y]));

                tube_top_to_cutoff_plane =
                    -OUTER_TUBE_RADIUS
                    -lowest_top_point.z
                    +cutoff
                    +(half_edge_offset+TUBE_DEPTH)*v.z;

                hull() {
                    // Move endpoint to base position along cutoff plane;
                    translate(clamped_base_position * [v.x, v.y, 0])
                    // Move endpoint downwards to cutoff plane
                    translate([0, 0, tube_top_to_cutoff_plane])
                    rotate(rotation)
                    cube([0.1, OUTER_TUBE_RADIUS, 0.1], center=true);

                    translate([0, 0, tube_top_to_cutoff_plane])
                    rotate(rotation)
                    cube([0.1, OUTER_TUBE_RADIUS, 0.1], center=true);


                    translate(half_edge_offset * v)
                    rotate(rotation)
                    difference() {
                        union() {
                            cylinder(r=OUTER_TUBE_RADIUS, h=TUBE_DEPTH);
                            translate([0, 0, -half_edge_offset])
                            cylinder(r=OUTER_TUBE_RADIUS, h=WALL_THICKNESS+half_edge_offset);
                        }
                        translate([-50+(EDGE_DIAMETER+DIAMETER_TOLERANCE_FIT)/2, 0, 0])
                        cube([100, 100, 100], center=true);
                    }
                }
            }

            // Tubes
            translate(half_edge_offset * v)
            rotate(rotation)
            difference() {
                union() {
                    cylinder(r=OUTER_TUBE_RADIUS, h=TUBE_DEPTH);
                    translate([0, 0, -half_edge_offset])
                    cylinder(r=OUTER_TUBE_RADIUS, h=WALL_THICKNESS+half_edge_offset);
                }
                // Add text to tube holders
                if (LABEL_VERTICES) {
                    rotate([0, 0, 90])
                    intersection() {
                        translate([0, 0, TUBE_DEPTH-WALL_THICKNESS])
                        rotate([0, 90, 0])
                        linear_extrude(20)
                        text(str(edge_list[i]), valign="center", size = OUTER_TUBE_RADIUS);
                        difference() {
                            cylinder(r=OUTER_TUBE_RADIUS, h=RADIUS, center=true);
                            cylinder(r=OUTER_TUBE_RADIUS-0.5, h=RADIUS, center=true);
                        };
                    };
                    rotate([0, 0, 270])
                    intersection() {
                        translate([0, 0, TUBE_DEPTH-WALL_THICKNESS])
                        rotate([0, 90, 0])
                        linear_extrude(20)
                        text(str(index), valign="center", size = OUTER_TUBE_RADIUS);
                        difference() {
                            cylinder(r=OUTER_TUBE_RADIUS, h=RADIUS, center=true);
                            cylinder(r=OUTER_TUBE_RADIUS-0.5, h=RADIUS, center=true);
                        };
                    };
                }
            }
        }

        for(i=[0:len(vecs)-1]) {
            v = vecs[i];
            rotation = direction_to_euler(v);
            half_edge_offset = offsets[i];
            translate(half_edge_offset * v)
            rotate(rotation)
            // A tiny offset is added to the length of the internal cylinder
            // to prevent z-fighting on the top surface
            union() {
                cylinder(
                    d1=EDGE_DIAMETER+DIAMETER_TOLERANCE_FIT-DIAMETER_TAPER_DECREASE,
                    d2=EDGE_DIAMETER+DIAMETER_TOLERANCE_FIT,
                    h=TUBE_DEPTH);
                cylinder(
                    d=EDGE_DIAMETER+DIAMETER_TOLERANCE_FIT,
                    h=RADIUS);
            }
        }

        // Flat bottom plane
        translate([0, 0, -50+cutoff])
        cube([100, 100, 100], center=true);
    }
}

module vertex_holder(index) {
    tubular_vertex_holder(vertex_figure, offsets, vertex_figure_edge, index);
}

vertex_holder();
