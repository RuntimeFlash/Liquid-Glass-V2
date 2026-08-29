// shaders/backdropBlur.frag
// Feathers the edges of a pure background blur so the whole-menu backdrop
// blends smoothly into the unblurred desktop instead of showing a hard-edged
// rectangle. Applies a rounded-corner alpha mask with an outward-only fade:
// full frost over the menu, then a long soft fade past the left/right/bottom
// edges. The top edge is flush with the menu's top (which sits against the
// bottom of the top panel) so the blur never covers the panel.

uniform sampler2D cogl_sampler;

uniform float resolution_x;
uniform float resolution_y;
uniform float corner_radius;
uniform float feather_px;

// Signed Distance Field for a rounded rectangle.
// Negative inside the shape, positive outside, 0 on the exact edge.
float sdRoundRect(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
    vec2 uv = cogl_tex_coord_in[0].xy;
    vec4 color = texture2D(cogl_sampler, uv);

    vec2 size = vec2(resolution_x, resolution_y);
    vec2 halfSize = size * 0.5;
    float feather = max(feather_px, 0.001);

    // Full-frost rounded rect, inset from the overlay by `feather` on the
    // left/right/bottom so the soft fade band fits inside the overlay, and
    // flush with the overlay top (the blur must not extend above the menu into
    // the top panel). Shifting the SDF center down by feather/2 realizes the
    // asymmetric (top-flush) rect.
    vec2 center = vec2(0.0, -feather * 0.5);
    vec2 b = vec2(max(halfSize.x - feather, 1.0), max(halfSize.y - feather * 0.5, 1.0));
    float r = min(corner_radius, min(b.x, b.y));
    vec2 p = uv * size - halfSize;
    float d = sdRoundRect(p - center, b - vec2(r), r);

    // Outward-only fade: alpha = 1 inside the rect, fading to 0 over `feather`
    // px outward. On sides/bottom the overlay extends exactly `feather` past
    // the rect, so alpha reaches 0 at the overlay edge (no hard line). The top
    // is flush to the overlay top, so nothing renders above the menu.
    float alpha = 1.0 - smoothstep(0.0, feather, d);

    // Premultiplied alpha, matching the Clutter/Cogl pipeline. The blur texture
    // is premultiplied, so fading by `alpha` must scale BOTH rgb and a together
    // (scaling only a leaves rgb too bright for its alpha and produces a bright,
    // saturated fringe at the mask edge). The final multiply by cogl_color_in
    // applies the actor's animated opacity.
    cogl_color_out = vec4(color.rgb * alpha, color.a * alpha) * cogl_color_in;
}