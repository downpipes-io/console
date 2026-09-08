// The animated canary illustration: a yellow canary in a hairline wire cage, four poses driven
// purely by the root state class (canary--alive | --dead | --ailing | --pending). The styling and
// all motion live in public/tokens.css (gated behind prefers-reduced-motion and the data-motion
// opt-in, exactly like the topology SVG); this module is just the trusted, in-repo markup the
// canary screen injects (the same innerHTML-over-a-constant pattern svgIcon uses). No server data,
// no inline styles, no <script>, no on* handlers, no url(#id) refs, so it is strict-CSP-safe.
//
// The .canary-umbrella and .canary-gumboots groups are a decorative storm flourish: both are hidden by
// default and revealed by CSS only in the alive pose AND only when the figure carries data-rain="storm"
// (the canary screen reflects the rain-backdrop preference onto the svg as an attribute), so under the
// Storm rain backdrop the singing bird raises an umbrella and puts on little gumboots. They ride inside
// .canary-bird so they sway and fade with the bird, and they are aria-hidden illustration colour (the
// teal rain-gear set) that adds no status meaning.
export const CANARY_SVG = `
<svg class="canary canary--alive" viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="canaryTitle canaryDesc">
  <title id="canaryTitle">Canary alive - singing.</title>
  <desc id="canaryDesc">A yellow canary perched and singing inside a hairline wire cage. The status marker is a green circle with a tick; the bird sits upright with chirp marks near its beak. When the canary is dead it lies slumped on its back with a crossed eye and legs up, the marker turns to a red square and the scene darkens. When ailing it hunches forward under an amber warning triangle. When pending it sleeps with its head tucked, under a neutral hollow marker. The bird is desaturated when the check is not alive.</desc>

  <g class="canary-plate">
    <rect class="canary-plate__bg" x="8" y="8" width="224" height="224" rx="20"/>
  </g>

  <g class="canary-status" transform="translate(34 34)">
    <circle class="canary-status__circle" cx="0" cy="0" r="13"/>
    <rect   class="canary-status__square" x="-12" y="-12" width="24" height="24" rx="3"/>
    <path   class="canary-status__triangle" d="M0 -14 L13 10 L-13 10 Z"/>
    <circle class="canary-status__hollow" cx="0" cy="0" r="12"/>
    <path class="canary-status__tick"  d="M-6 0 L-2 5 L7 -6"/>
    <path class="canary-status__cross" d="M-6 -6 L6 6 M6 -6 L-6 6"/>
    <path class="canary-status__bang"  d="M0 -7 L0 3 M0 7 L0 8"/>
    <circle class="canary-status__dot" cx="0" cy="0" r="3.4"/>
  </g>

  <g class="canary-cage">
    <g class="canary-cage__hook">
      <path class="canary-cage__cord" d="M120 26 L120 40"/>
      <circle class="canary-cage__ring" cx="120" cy="20" r="7"/>
    </g>

    <g class="canary-cage__body">
      <path class="canary-cage__dome" d="M70 70 A52 46 0 0 1 170 70"/>
      <path class="canary-cage__dome-rib" d="M120 41 L120 70"/>
      <path class="canary-cage__dome-rib" d="M95 47 Q120 60 120 70"/>
      <path class="canary-cage__dome-rib" d="M145 47 Q120 60 120 70"/>

      <path class="canary-cage__sheen" d="M84 56 A46 40 0 0 1 156 56 Q120 66 84 56 Z"/>

      <path class="canary-cage__hoop" d="M68 72 L172 72"/>
      <path class="canary-cage__hoop" d="M64 176 L176 176"/>

      <path class="canary-cage__bar" d="M70 72 L66 176"/>
      <path class="canary-cage__bar" d="M89 72 L87 176"/>
      <path class="canary-cage__bar" d="M108 72 L107 176"/>
      <path class="canary-cage__bar canary-cage__bar--front" d="M132 72 L133 176"/>
      <path class="canary-cage__bar canary-cage__bar--front" d="M151 72 L153 176"/>
      <path class="canary-cage__bar canary-cage__bar--front" d="M170 72 L174 176"/>

      <path class="canary-cage__base" d="M58 176 L182 176 L176 192 L64 192 Z"/>
      <path class="canary-cage__base-line" d="M62 184 L178 184"/>

      <g class="canary-perch">
        <path class="canary-perch__bar" d="M88 159 L152 159"/>
        <circle class="canary-perch__cap" cx="88" cy="159" r="2.4"/>
        <circle class="canary-perch__cap" cx="152" cy="159" r="2.4"/>
      </g>

      <g class="canary-bird">
        <g class="canary-bird__breath">
          <path class="canary-bird__tail" d="M138 130 L170 120 L168 138 L142 142 Z"/>
          <g class="canary-bird__legs">
            <path class="canary-bird__leg" d="M114 148 L113 159 M113 159 L108 162 M113 159 L118 162"/>
            <path class="canary-bird__leg" d="M126 148 L127 159 M127 159 L122 162 M127 159 L132 162"/>
          </g>
          <ellipse class="canary-bird__body" cx="120" cy="129" rx="27" ry="23.5"/>
          <path class="canary-bird__shine" d="M110 114 Q101 122 106 135"/>
          <path class="canary-bird__wing" d="M123 119 Q141 123 139 141 Q127 139 117 132 Z"/>
          <path class="canary-bird__wing-line" d="M124 126 L136 133"/>
          <g class="canary-bird__head">
            <circle class="canary-bird__skull" cx="103" cy="108" r="16"/>
            <path class="canary-bird__beak" d="M88 105 L73 110 L88 115 Z"/>
            <circle class="canary-bird__eye" cx="99" cy="104" r="3.7"/>
            <circle class="canary-bird__catch" cx="100.3" cy="102.7" r="1.25"/>
            <path class="canary-bird__lid" d="M93.5 105 Q99 101.5 104.5 105"/>
          </g>
        </g>

        <g class="canary-umbrella" aria-hidden="true">
          <path class="canary-umbrella__pole"    d="M110 58 L124 86 L124 134"/>
          <path class="canary-umbrella__handle"  d="M124 134 q0 6 -6 6 q-4 0 -4 -3"/>
          <path class="canary-umbrella__canopy"  d="M78 86 Q74 56 106 54 Q138 56 138 84 Q131 96 124 86 Q117 96 108 86 Q100 96 93 87 Q85 96 78 86 Z"/>
          <path class="canary-umbrella__panel"   d="M106 54 L93 87 Q100 96 108 86 Z"/>
          <path class="canary-umbrella__panel"   d="M106 54 L124 86 Q131 96 138 84 Z"/>
          <path class="canary-umbrella__seam"    d="M106 54 L93 87"/>
          <path class="canary-umbrella__seam"    d="M106 54 L108 86"/>
          <path class="canary-umbrella__seam"    d="M106 54 L124 86"/>
          <path class="canary-umbrella__ferrule" d="M106 54 L106 47"/>
        </g>

        <g class="canary-gumboots" aria-hidden="true">
          <path class="canary-gumboot" d="M118 150 L118 162 Q118 164 116 164 L106 164 Q104 164 104 161 Q104 159 106 159 L110 159 L110 150 Z"/>
          <path class="canary-gumboot" d="M130 150 L130 162 Q130 164 128 164 L118 164 Q116 164 116 161 Q116 159 118 159 L122 159 L122 150 Z"/>
          <path class="canary-gumboot__shine" d="M112 152 L112 158"/>
          <path class="canary-gumboot__shine" d="M124 152 L124 158"/>
        </g>
      </g>

      <g class="canary-dead-bird">
        <path class="canary-deadbird__tail" d="M142 152 L166 146 L164 160 L146 160 Z"/>
        <ellipse class="canary-deadbird__body" cx="118" cy="152" rx="26" ry="13"/>
        <path class="canary-deadbird__shine" d="M106 146 Q118 142 130 146"/>
        <circle class="canary-deadbird__skull" cx="92" cy="156" r="12"/>
        <path class="canary-deadbird__beak" d="M81 154 L68 158 L81 161 Z"/>
        <path class="canary-deadbird__x" d="M86 151 L93 158 M93 151 L86 158"/>
        <path class="canary-deadbird__leg" d="M114 140 L112 127 M112 127 L108 124 M112 127 L116 124"/>
        <path class="canary-deadbird__leg" d="M126 141 L128 128 M128 128 L124 125 M128 128 L132 125"/>
      </g>

      <g class="canary-skeleton">
        <path class="canary-skeleton__bone" d="M98 158 Q120 151 152 156"/>
        <path class="canary-skeleton__bone" d="M108 156 q3 7 1 12"/>
        <path class="canary-skeleton__bone" d="M118 154 q3 7 1 13"/>
        <path class="canary-skeleton__bone" d="M128 154 q3 6 1 12"/>
        <path class="canary-skeleton__bone" d="M138 155 q2 6 0 11"/>
        <path class="canary-skeleton__bone" d="M120 154 L133 142 L141 146"/>
        <path class="canary-skeleton__bone" d="M132 157 L130 141 M130 141 L126 138 M130 141 L133 137"/>
        <path class="canary-skeleton__bone" d="M142 157 L145 141 M145 141 L142 137 M145 141 L149 138"/>
        <path class="canary-skeleton__bone" d="M152 156 L166 152 M152 158 L166 159"/>
        <path class="canary-skeleton__bone" d="M112 160 L120 164 M120 160 L112 164"/>
        <circle class="canary-skeleton__skull" cx="90" cy="158" r="8.5"/>
        <circle class="canary-skeleton__socket" cx="91" cy="157" r="2.6"/>
        <path class="canary-skeleton__beak" d="M82 157 L70 160 L82 163 Z"/>
      </g>

      <g class="canary-feathers">
        <path class="canary-feather canary-feather--a" d="M150 96 q5 4 0 9 q-5 -2 0 -9 Z"/>
        <path class="canary-feather canary-feather--b" d="M96 86 q4 3 0 7 q-4 -1 0 -7 Z"/>
      </g>
    </g>
  </g>

  <g class="canary-chirp">
    <g transform="translate(67 108)"><g class="canary-note canary-note--1">
      <ellipse class="canary-note__head" cx="0" cy="0" rx="2.8" ry="2.1"/>
      <path class="canary-note__stem" d="M2.5 -0.6 L2.5 -9.6"/>
      <path class="canary-note__flag" d="M2.5 -9.6 q4 0.8 2.8 4.6"/>
    </g></g>
    <g transform="translate(64 112)"><g class="canary-note canary-note--2">
      <ellipse class="canary-note__head" cx="0" cy="0" rx="2.4" ry="1.8"/>
      <path class="canary-note__stem" d="M2.2 -0.5 L2.2 -8"/>
      <path class="canary-note__flag" d="M2.2 -8 q3.4 0.7 2.4 4"/>
    </g></g>
    <g transform="translate(70 105)"><g class="canary-note canary-note--3">
      <ellipse class="canary-note__head" cx="0" cy="0" rx="2.6" ry="2"/>
      <path class="canary-note__stem" d="M2.4 -0.6 L2.4 -8.8"/>
      <path class="canary-note__flag" d="M2.4 -8.8 q3.8 0.8 2.6 4.4"/>
    </g></g>
  </g>

  <g class="canary-sleep">
    <path class="canary-sleep__z canary-sleep__z--1" d="M150 92 h7 l-7 8 h7"/>
    <path class="canary-sleep__z canary-sleep__z--2" d="M162 78 h9 l-9 10 h9"/>
  </g>
</svg>
`;
