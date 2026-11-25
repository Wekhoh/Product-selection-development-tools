// Extracted V4 Curatorial Studio (01 视觉策展室) stylesheet constants for src/report.mjs.
export const R58_STUDIO_CSS = `
:root{
  color-scheme:light;
  --ease:cubic-bezier(.22,1,.36,1);
  --sans:"Hanken Grotesk","Noto Sans SC","PingFang SC","HarmonyOS Sans SC","Source Han Sans SC","Microsoft YaHei UI",sans-serif;
  --serif-it:"Newsreader",Georgia,serif;
  --canvas:#ffffff;
  --plinth:#f4f5f8;
  --quiet:rgba(9,9,11,.03);
  --ink:#09090b;
  --ink-2:#1c1d22;
  --muted:#383a42;
  --hairline:rgba(9,9,11,.13);
  --hairline-strong:rgba(9,9,11,.26);
  --vermilion:#c42b00;
  --forest:#036647;
  --amber:#8a4800;
  --dot-pass:#036647;
  --dot-warn:#8a4800;
  --dot-fail:#c42b00;
  --ink-pass:#036647;
  --ink-fail:#c42b00;
}
*{box-sizing:border-box}
html{
  scroll-behavior:smooth;
  scroll-padding-top:2.5rem;
  scrollbar-color:#6b6e78 transparent;
  accent-color:var(--vermilion);
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{
  margin:0;
  background:var(--canvas);
  color:var(--ink);
  font-family:var(--sans);
  font-weight:460;
  font-size:0.96875rem;
  line-height:1.74;
  overflow-wrap:anywhere;
}
::selection{background:rgba(196,43,0,.16);color:var(--ink)}
h1,h2,h3,h4,p,figure,dl,dd{margin:0}
h1,h2,th{text-wrap:balance}
p{text-wrap:pretty}
h1{
  font-size:clamp(2.05rem,1.5rem + 1.8vw,2.8rem);
  font-weight:580;
  letter-spacing:0.02em;
  line-height:1.18;
}
h2{
  font-size:clamp(1.7rem,1.3rem + 1.2vw,2.35rem);
  font-weight:560;
  letter-spacing:0.018em;
  line-height:1.24;
}
h3{
  font-size:1.25rem;
  font-weight:590;
  letter-spacing:0.012em;
  line-height:1.35;
}
h4{
  font-size:1.03125rem;
  font-weight:560;
  line-height:1.45;
}
.group-title{font-size:1rem;font-weight:600;color:var(--ink)}
.item-title{font-size:0.9375rem;font-weight:560;color:var(--ink)}
a{
  color:var(--ink);
  text-underline-offset:0.26em;
  text-decoration-color:var(--hairline-strong);
  text-decoration-thickness:1px;
}
a:hover{text-decoration-color:var(--vermilion)}
a:focus-visible,summary:focus-visible,.table-scroll:focus-visible,.tn-tab:has(:focus-visible),.seg-btn:has(:focus-visible){
  outline:2px solid var(--vermilion);
  outline-offset:3px;
}
.ico{display:inline-block;vertical-align:-0.12em;flex-shrink:0}
.sep-bar{display:inline-block;width:1px;height:0.65rem;background:var(--hairline-strong);margin-inline:0.45rem;vertical-align:-1px}
.num,.num-col,.side-ledger dd{
  font-family:"Hanken Grotesk",var(--sans);
  font-variant-numeric:tabular-nums;
  letter-spacing:-0.022em;
}
.ed-idx,.mono-idx{
  font-family:var(--serif-it);
  font-style:italic;
  font-weight:520;
  font-size:1.0625rem;
  letter-spacing:0;
  color:#2c2e36;
}
.ed-idx-lg{font-size:1.375rem;color:var(--vermilion);font-weight:540}
code,.mono-id,.mono-kw{
  font-family:"Hanken Grotesk",var(--sans);
  font-size:0.875rem;
}
.mono-id{color:var(--muted);font-weight:500}
.mono-kw{color:var(--ink);font-weight:580}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip-link{position:absolute;top:-6rem;left:1rem;background:var(--ink);color:#fff;padding:0.5rem 0.9rem;z-index:80;text-decoration:none;font-size:0.875rem}
.skip-link:focus{top:0.75rem}
.filter-radio,.tab-radio,.mode-check{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}

.studio-page{
  max-width:98.75rem;
  margin-inline:auto;
  padding:3.25rem 4.5vw 7rem;
}

/* Asymmetric Magazine Masthead */
.masthead{
  display:flex;
  justify-content:space-between;
  align-items:flex-end;
  gap:1.75rem 2.5rem;
  flex-wrap:wrap;
  padding-bottom:2.25rem;
  border-bottom:1px solid var(--hairline);
}
.mh-left{max-width:56rem}
.mh-colophon{
  margin-top:0.6rem;
  font-size:1rem;
  color:var(--ink-2);
  max-width:65ch;
}
.mh-en{
  font-family:var(--serif-it);
  font-style:italic;
  font-weight:500;
  font-size:1.0625rem;
  color:#272930;
  letter-spacing:0.005em;
}
.mh-sep{color:var(--muted);margin-inline:0.4rem}
.batch-counts{
  margin-top:0.55rem;
  color:var(--ink-2);
  font-size:0.9375rem;
  font-weight:460;
  line-height:1.72;
  max-width:68ch;
}
.mh-right{
  display:flex;
  flex-direction:column;
  align-items:flex-end;
  gap:0.75rem;
  max-width:100%;
}

/* Pure Unboxed Single-Row Scrollable Navigation & Tabs */
.typo-nav,.segmented-track{
  display:flex;
  align-items:baseline;
  gap:1.6rem;
  overflow-x:auto;
  max-inline-size:100%;
  scrollbar-width:none;
  scroll-snap-type:inline proximity;
  padding-bottom:0.35rem;
}
.typo-nav::-webkit-scrollbar,.segmented-track::-webkit-scrollbar{display:none}
.tn-tab,.seg-btn{
  position:relative;
  flex:none;
  scroll-snap-align:start;
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  gap:0.4rem;
  min-block-size:2.1rem;
  padding:0.25rem 0 0.45rem;
  font-size:0.9375rem;
  font-weight:550;
  color:#2c2e36;
  text-decoration:none;
  user-select:none;
  transition:color .2s ease;
}
.tn-tab:hover,.seg-btn:hover{color:var(--ink)}
.tn-tab:has(:checked),.seg-btn:has(:checked){
  color:var(--ink);
}
.tn-tab:has(:checked)::after,.seg-btn:has(:checked)::after{
  content:"";
  position:absolute;
  inset:auto 0 0;
  border-block-end:2.5px solid var(--vermilion);
}
.queue-nav{
  display:flex;
  align-items:baseline;
  gap:1.1rem;
  flex-wrap:wrap;
  font-size:0.875rem;
  font-weight:520;
}
.queue-nav a{color:#25272e;text-decoration:underline;text-decoration-color:rgba(9,9,11,.36)}
.queue-nav a:hover{color:var(--ink);text-decoration-color:var(--vermilion)}

/* Staggered Art-Gallery Exhibition Plinth Reel */
.exhibition-reel{
  display:grid;
  grid-template-columns:repeat(var(--reel-cols,5),minmax(0,1fr));
  gap:1.75rem;
  align-items:start;
  padding:2.25rem 0 3.5rem;
  border-bottom:1px solid var(--hairline);
}
@media(hover:hover){
  .exhibition-reel:hover .plinth-item:not(:hover){opacity:.55}
  .plinth-item:hover{transform:translateY(-4px)}
  .plinth-item:hover .plinth-photo img{transform:scale(1.045)}
}
.plinth-item{
  display:flex;
  flex-direction:column;
  text-decoration:none;
  color:inherit;
  transition:opacity .35s ease,transform .35s var(--ease);
}
.plinth-item.is-stagger{margin-top:1.375rem}
.plinth-photo{
  position:relative;
  aspect-ratio:4/3;
  background:var(--plinth);
  overflow:hidden;
  border-radius:3px;
}
.plinth-photo img{
  display:block;
  width:100%;
  height:100%;
  object-fit:cover;
  transition:transform .55s var(--ease);
}
.plinth-photo-typo{
  display:grid;
  place-items:center;
  padding:1.25rem;
}
.plinth-specimen{text-align:center}
.ps-big{display:block;font-size:clamp(1.6rem,1.2rem + 1.2vw,2.35rem);font-weight:560;line-height:1.05}
.ps-sub{display:block;margin-top:0.4rem;font-size:0.875rem;font-weight:500;color:var(--muted)}
.plinth-caption{
  padding-top:1.375rem;
  position:relative;
}
.pc-row1{
  display:flex;
  align-items:baseline;
  gap:0.625rem;
}
.pc-title{
  font-size:1rem;
  font-weight:560;
  letter-spacing:0.012em;
  line-height:1.4;
  color:var(--ink);
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.pc-row2{
  margin-top:0.4rem;
  padding-inline-start:1.6875rem;
  display:flex;
  align-items:baseline;
  flex-wrap:wrap;
  gap:0.45rem;
  font-size:0.875rem;
  font-weight:500;
  color:#2c2e36;
}
.pc-sep{color:#6b6e78}
.pc-active-bar{
  display:block;
  margin-top:0.95rem;
  height:2.5px;
  width:0;
  background:var(--ink);
  transition:width .38s var(--ease);
}
.studio-page:not(:has(.candidate:target)) .exhibition-reel .plinth-item:first-child .ed-idx{color:var(--vermilion)}
.studio-page:not(:has(.candidate:target)) .exhibition-reel .plinth-item:first-child .pc-active-bar{width:100%}

/* Open Architectural Split Stage */
.candidate{
  padding-block:4rem;
  border-bottom:1px solid var(--hairline);
  scroll-margin-top:2rem;
}
.split-stage{
  display:grid;
  grid-template-columns:minmax(0,1.04fr) 1px minmax(0,1fr);
  gap:3.25rem;
  align-items:stretch;
}
.stage-hairline{background:var(--hairline)}
.left-wing{min-width:0}
@media(min-width:72rem){
  .left-wing{position:sticky;top:2rem;align-self:start}
}
.right-wing{min-width:0}
.title-line{
  display:flex;
  align-items:baseline;
  gap:0.75rem;
}
.title-line h2{flex:1;min-width:0}
.status-row{
  margin-top:0.6rem;
  display:flex;
  align-items:center;
  flex-wrap:wrap;
  gap:0.5rem 0.65rem;
  font-size:0.90625rem;
  font-weight:500;
}
.st-en{
  font-family:var(--serif-it);
  font-style:italic;
  font-weight:500;
  font-size:1.03125rem;
  color:#272930;
  letter-spacing:0.005em;
}
.lead-copy{
  margin-top:1.1rem;
  font-size:1rem;
  font-weight:470;
  line-height:1.74;
  letter-spacing:0.012em;
  color:var(--ink);
  max-width:60ch;
}
.spec-copy{
  margin-top:0.55rem;
  font-size:0.90625rem;
  font-weight:460;
  line-height:1.68;
  color:var(--ink-2);
  max-width:62ch;
}
.star-ref{margin-top:0.5rem;font-size:0.90625rem;font-weight:460;color:var(--ink-2);max-width:62ch}

/* Dramatic Sculptural Margin Readout */
.sculptural-metrics{
  margin-top:1.5rem;
  padding:1.65rem 0;
  border-top:1px solid var(--hairline);
  border-bottom:1px solid var(--hairline);
}
.sm-primary-row{
  display:flex;
  align-items:flex-end;
  justify-content:space-between;
  gap:1.25rem 1.75rem;
  flex-wrap:wrap;
}
.sm-label{
  display:block;
  font-size:0.875rem;
  font-weight:520;
  color:#2c2e36;
  margin-bottom:0.45rem;
}
.hero-stat-val{
  font-size:clamp(3.15rem,2rem + 3.2vw,5.2rem);
  font-weight:560;
  letter-spacing:-0.038em;
  line-height:0.96;
}
.hero-stat-val.is-range{
  font-size:clamp(2.25rem,1.5rem + 1.9vw,3.35rem);
  letter-spacing:-0.035em;
}
.sm-side-pair{
  display:flex;
  gap:1.65rem;
  flex-wrap:wrap;
}
.sm-side-item span{
  display:block;
  font-size:0.875rem;
  font-weight:520;
  color:#2c2e36;
  margin-bottom:0.25rem;
}
.sm-side-item strong{
  font-size:clamp(1.25rem,1.05rem + 0.5vw,1.6rem);
  font-weight:560;
  line-height:1.08;
}
.hero-stat-sub{
  margin-top:0.85rem;
  font-size:0.90625rem;
  font-weight:500;
  line-height:1.55;
}

.side-ledger{
  margin-top:0.2rem;
  margin-bottom:1rem;
  display:flex;
  flex-direction:column;
}
.side-ledger>div{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  gap:1rem;
  padding:0.7rem 0;
  border-bottom:1px solid var(--hairline);
  font-size:0.90625rem;
}
.side-ledger dt{color:#2c2e36;font-weight:500;flex-shrink:0}
.side-ledger dd{text-align:right;color:var(--ink);font-weight:530}

.inline-score-status{
  margin-top:1.1rem;
  padding-block:0.75rem;
  border-bottom:1px solid var(--hairline);
  font-size:0.90625rem;
}
.quiet-surface{
  margin-top:1.35rem;
  padding-top:1.15rem;
  border-top:1px solid var(--hairline);
}
.brief-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr));
  gap:1.25rem 1.75rem;
}
.brief-col h3{margin-bottom:0.5rem;color:var(--ink)}
.brief-list{padding-inline-start:1.15em;margin:0;font-size:0.90625rem;line-height:1.68;color:var(--ink-2)}
.brief-list li+li{margin-top:0.45rem}

/* Status Indicators (Zero Pill Boxes) */
.dot{
  width:0.4rem;
  height:0.4rem;
  border-radius:9999px;
  display:inline-block;
  flex-shrink:0;
  background:var(--muted);
}
.state-pass .dot,.dot-pass{background:var(--dot-pass)}
.state-pending .dot,.dot-pending,.dot-warn{background:var(--dot-warn)}
.state-fail .dot,.dot-fail{background:var(--dot-fail)}
.state-inline{
  display:inline-flex;
  align-items:center;
  gap:0.4rem;
  font-size:0.90625rem;
  font-weight:560;
  color:var(--ink);
}
.state-pass{color:var(--forest)}
.state-fail{color:var(--vermilion)}
.state-pending{color:var(--amber)}
.ink-pass{color:var(--ink-pass)}
.ink-fail{color:var(--ink-fail)}
.ink-muted,.muted{color:var(--muted)}

/* Right Wing Tabs & Nightingale Polar Rose */
.card-tabs .segmented-track{
  gap:1.2rem;
  border-bottom:1px solid var(--hairline);
  padding-bottom:0;
  margin-bottom:1.75rem;
}
.tab-panel{display:none}
.card-tabs:has(input[id$="-t1"]:checked) .tab-p1,
.card-tabs:has(input[id$="-t2"]:checked) .tab-p2,
.card-tabs:has(input[id$="-t3"]:checked) .tab-p3,
.card-tabs:has(input[id$="-t4"]:checked) .tab-p4,
.card-tabs:has(input[id$="-t5"]:checked) .tab-p5{
  display:block;
}
.card-tabs:has(.tab-panel-bib :target) .tab-panel-bib{
  display:block;
  margin-top:1.5rem;
  padding-top:1.5rem;
  border-top:1px solid var(--hairline-strong);
}
@supports not selector(:has(*)){
  .tab-panel{display:block;margin-top:1.5rem}
}

.polar-wrap{
  display:grid;
  grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);
  gap:1.5rem;
  align-items:center;
  padding-bottom:1.75rem;
  border-bottom:1px solid var(--hairline);
  margin-bottom:1.5rem;
}
.rose-svg{width:100%;max-width:22rem;height:auto;display:block;margin-inline:auto}
.rose-ring{fill:none;stroke:rgba(9,9,11,.11);stroke-width:1}
.rose-petal{
  fill:rgba(9,9,11,.16);
  stroke:#ffffff;
  stroke-width:1.5;
  transition:fill .24s ease;
}
.rose-sector:hover .rose-petal,.rose-sector.is-sel .rose-petal{fill:var(--ink)}
.rose-lbl{
  font-family:var(--sans);
  font-size:0.8125rem;
  font-weight:540;
  fill:#272930;
  transition:fill .2s ease;
}
.rose-sector:hover .rose-lbl,.rose-sector.is-sel .rose-lbl{fill:var(--ink);font-weight:680}
.pd-k{display:block;font-size:0.875rem;font-weight:520;color:#2c2e36}
.pd-big{font-size:clamp(2.05rem,1.65rem + 1.1vw,2.7rem);font-weight:560;line-height:1.08;margin-top:0.25rem}
.pd-big small{font-size:1.0625rem;color:var(--muted);font-weight:500}
.polar-group-summary{
  margin-top:1rem;
  padding-top:0.8rem;
  border-top:1px solid var(--hairline);
  display:grid;
  grid-template-columns:1fr;
  gap:0.32rem;
  font-size:0.875rem;
  font-weight:500;
}
.pgs-row{display:flex;justify-content:space-between;gap:0.75rem;color:#272930;white-space:nowrap}
.pgs-row.is-sel{color:var(--ink);font-weight:640}

.period-meta-line{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  flex-wrap:wrap;
  gap:0.65rem 1.5rem;
  padding-bottom:0.85rem;
  border-bottom:1px solid var(--hairline);
}
.period-note{margin-top:0.3rem;font-size:0.90625rem;color:var(--ink-2);max-width:62ch}
.period-inline-nums{display:flex;gap:1rem;flex-wrap:wrap;font-size:0.90625rem;color:var(--ink-2)}
.period-inline-nums strong{color:var(--ink)}
.coverage-line{margin-top:0.55rem;font-size:0.90625rem;color:var(--ink-2);max-width:65ch}

/* Tables, Waterfalls, Score Rows & Disclosures */
.ledger-section{margin-top:2rem}
.ledger-section>h3{margin-bottom:0.65rem}
.section-head{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  flex-wrap:wrap;
  gap:0.4rem 1rem;
  margin-bottom:0.65rem;
}
.section-lead{margin-bottom:0.4rem;max-width:65ch}

.alloc-strip{
  margin:0.5rem 0 1.25rem;
  padding:0.9rem 0;
  border-top:1px solid var(--hairline);
  border-bottom:1px solid var(--hairline);
}
.alloc-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:0.4rem 1rem;font-size:0.875rem;margin-bottom:0.55rem}
.alloc-track{position:relative;display:flex;height:0.4rem;background:rgba(9,9,11,.08);overflow:hidden}
.alloc-seg{height:100%;display:block}
.alloc-supply{background:#18181b}
.alloc-platform{background:#71717a}
.alloc-margin-pass{background:var(--forest)}
.alloc-margin-fail{background:var(--vermilion)}
.alloc-tick{position:absolute;top:0;bottom:0;left:70%;width:1.5px;background:var(--canvas);box-shadow:0 0 0 .75px var(--ink)}
.alloc-legend{display:flex;flex-wrap:wrap;gap:0.5rem 1.25rem;margin-top:0.6rem;font-size:0.875rem;color:var(--ink-2)}
.alloc-legend span{display:inline-flex;align-items:center;gap:0.4rem}
.swatch{width:0.45rem;height:0.45rem;display:inline-block;flex-shrink:0}
.swatch-supply{background:#18181b}
.swatch-platform{background:#71717a}
.swatch-pass{background:var(--forest)}
.swatch-fail{background:var(--vermilion)}

.table-scroll{
  overflow:auto;
  max-inline-size:100%;
  container-type:inline-size;
  scrollbar-color:#6b6e78 transparent;
}
.hairline-table{
  width:100%;
  border-collapse:separate;
  border-spacing:0;
  font-size:0.90625rem;
}
.hairline-table th,.hairline-table td{
  padding:0.7rem 0.85rem;
  text-align:left;
  border-bottom:1px solid var(--hairline);
  vertical-align:middle;
}
.hairline-table th:first-child,.hairline-table td:first-child{padding-inline-start:0}
.hairline-table th:last-child,.hairline-table td:last-child{padding-inline-end:0}
.hairline-table thead th{
  position:sticky;
  inset-block-start:0;
  z-index:2;
  background:var(--canvas);
  color:#2c2e36;
  font-weight:560;
  border-bottom:1px solid var(--hairline-strong);
  white-space:nowrap;
}
.hairline-table .num-col{text-align:right;white-space:nowrap}
.hairline-table tbody th{
  position:sticky;
  inset-inline-start:0;
  z-index:1;
  background:var(--canvas);
  font-weight:540;
  color:var(--ink);
}
.hairline-table tbody tr:hover th,.hairline-table tbody tr:hover td{background:#f8f9fb}
.th-note{display:block;font-size:0.84375rem;font-weight:460;color:var(--muted)}
.waterfall-table .row-dim th,.waterfall-table .row-dim td{color:var(--muted)}
.waterfall-table .row-sum th,.waterfall-table .row-sum td{border-top:1px solid var(--hairline-strong)}

.scenario-folds{margin-top:0.5rem}
.quiet-fold{border-bottom:1px solid var(--hairline)}
summary{
  list-style:none;
  cursor:pointer;
  display:flex;
  align-items:center;
  gap:0.5rem;
  min-block-size:2.4rem;
  padding:0.6rem 0;
  font-size:0.90625rem;
  font-weight:560;
  color:var(--ink);
}
summary::-webkit-details-marker{display:none}
summary::before{
  content:"";
  width:0.35rem;
  height:0.35rem;
  border-right:1.5px solid currentColor;
  border-bottom:1.5px solid currentColor;
  transform:rotate(-45deg);
  flex-shrink:0;
}
details[open]>summary::before{transform:rotate(45deg)}
@media(prefers-reduced-motion:no-preference){
  summary::before{transition:transform .16s ease}
  details::details-content{
    interpolate-size:allow-keywords;
    overflow:clip;
    contain:layout;
    transition:block-size .2s ease,content-visibility .2s ease;
    transition-behavior:allow-discrete;
  }
  details:not([open])::details-content{block-size:0}
}
summary:hover{color:var(--vermilion)}
.fold-body{padding:0.25rem 0 1rem 0.95rem;font-size:0.90625rem;color:var(--ink-2)}
.fold-body h3{margin:0.75rem 0 0.4rem}
.fold-body ul{padding-inline-start:1.2em;margin:0.4rem 0}
.fold-body li+li{margin-top:0.35rem}

.score-columns{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr));
  gap:1.5rem 2.25rem;
}
.score-group{border-top:1px solid var(--hairline-strong);padding-top:0.65rem}
.group-bar{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  gap:0.75rem;
  padding-bottom:0.5rem;
  border-bottom:1px solid var(--hairline);
}
.group-pts{font-size:0.875rem;font-weight:550;color:var(--ink-2)}
.item-row{padding:0.8rem 0;border-bottom:1px solid var(--hairline);font-size:0.90625rem}
.item-heading{display:flex;justify-content:space-between;align-items:baseline;gap:0.75rem;margin-bottom:0.25rem}
.item-score{font-weight:580;flex-shrink:0}
.item-input{color:var(--ink-2)}
.item-reason{margin-top:0.2rem;color:var(--ink)}
.item-row>.source{margin-top:0.3rem}
.item-qualifier{display:none}
.studio-page:has(#expand-qualifiers:checked) .item-qualifier{display:block}
.cite-fold{border:0;margin-top:0.15rem}
.cite-fold>summary{min-block-size:1.6rem;padding:0.15rem 0;color:var(--muted);font-size:0.84375rem}

.bid-block{margin-top:0.65rem;padding-top:0.65rem;border-top:1px solid var(--hairline)}
.bid-summary-line{margin-bottom:0.25rem}
.bid-rows{margin-top:0.5rem;border-top:1px solid var(--hairline)}
.bid-row{padding:0.65rem 0}
.bid-row+.bid-row{border-top:1px solid var(--hairline)}
.bid-row-head{display:flex;justify-content:space-between;align-items:baseline;gap:0.65rem;flex-wrap:wrap}
.bid-row-meta{font-size:0.875rem;color:var(--ink-2)}
.bid-sub{margin-top:0.15rem}

.kv-rows{border-top:1px solid var(--hairline)}
.kv-row{
  display:grid;
  grid-template-columns:12rem minmax(0,1fr);
  gap:1rem;
  padding:0.75rem 0;
  border-bottom:1px solid var(--hairline);
  font-size:0.90625rem;
}
.kv-row dt{color:#2c2e36;font-weight:540}
.kv-main{color:var(--ink);font-weight:540}
.pill-link{
  display:inline-flex;
  align-items:center;
  gap:0.25rem;
  margin-inline-start:0.45rem;
  color:var(--ink);
  text-decoration:underline;
  text-decoration-color:var(--vermilion);
  text-underline-offset:0.24em;
  font-size:0.875rem;
  font-weight:550;
}

/* Contact Sheet & Pure-CSS :target Lightbox */
.contact-sheet-frame{margin:0.5rem 0 0}
.zoom-trigger{display:block;text-decoration:none;cursor:zoom-in;background:var(--plinth);border-radius:4px;overflow:hidden}
.contact-sheet-frame img{display:block;width:100%;max-height:32rem;object-fit:contain;margin-inline:auto}
.contact-sheet-frame figcaption{
  margin-top:0.75rem;
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  gap:1rem;
  flex-wrap:wrap;
  font-size:0.875rem;
  color:var(--ink-2);
}
.zoom-hint{color:var(--ink);font-weight:550;text-decoration:underline;text-decoration-color:var(--vermilion);flex-shrink:0}
.css-lightbox{display:none;position:fixed;inset:0;z-index:120;place-items:center;padding:2vw}
.css-lightbox:target{display:grid}
.lb-backdrop{position:absolute;inset:0;background:rgba(9,9,11,.78);cursor:zoom-out}
.lb-sheet{
  position:relative;
  z-index:1;
  width:min(94vw,82rem);
  max-height:92vh;
  overflow:auto;
  background:var(--canvas);
  padding:1.5rem 2rem;
  border-radius:6px;
  box-shadow:0 24px 64px rgba(0,0,0,.28);
}
.lb-head{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;padding-bottom:0.9rem;border-bottom:1px solid var(--hairline);margin-bottom:1.1rem}
.lb-close{color:var(--vermilion);font-weight:560;text-decoration:underline}
.lb-sheet img{display:block;width:100%;max-height:78vh;object-fit:contain}

.lead-list,.bibliography{padding-inline-start:1.35em;margin:0.5rem 0;font-size:0.90625rem}
.lead-list li+li{margin-top:0.55rem}
.bibliography li{padding:0.65rem 0.4rem;border-bottom:1px solid var(--hairline);scroll-margin-top:4rem}
.bibliography li:target{background:var(--plinth)}
.bib-head{display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem 1rem;flex-wrap:wrap}
.bib-meta{color:var(--muted);font-size:0.84375rem}

.source{font-size:0.84375rem;line-height:1.6;color:var(--muted)}
p+p{margin-top:0.35rem}

/* Comparison Matrix Ledger & Footer */
.matrix-block{margin-top:4rem;padding-top:2.5rem;border-top:1px solid var(--hairline)}
.row-jump{text-decoration:underline;text-decoration-color:var(--hairline-strong);font-weight:550}
.row-jump .mono-idx{margin-inline-end:0.45rem}
.matrix-check{color:var(--ink-2);max-width:28ch}
.method-section{margin-top:2.75rem}
.empty-state{padding:3rem 0;border-top:1px solid var(--hairline)}
.filter-empty{display:none;padding:2.5rem 0;border-bottom:1px solid var(--hairline);font-size:0.96875rem}
.report-footer{
  margin-top:2.5rem;
  padding-top:1.5rem;
  border-top:1px solid var(--hairline);
  font-size:0.875rem;
  color:var(--ink-2);
  display:flex;
  justify-content:space-between;
  flex-wrap:wrap;
  gap:0.5rem 1.5rem;
}

@media (forced-colors:active){
  .tn-tab:has(:checked)::after,.seg-btn:has(:checked)::after{border-block-end-color:Highlight}
  .pc-active-bar{background:Highlight}
  .stage-hairline{background:CanvasText}
}

/* Pure-CSS Filter Rules */
.studio-page:has(#filter-pass:checked) :is(.plinth-item,.candidate,.matrix-table tbody tr):not([data-eligible="true"]),
.studio-page:has(#filter-pending:checked) :is(.plinth-item,.candidate,.matrix-table tbody tr):not([data-bucket="pending"]),
.studio-page:has(#filter-hold:checked) :is(.plinth-item,.candidate,.matrix-table tbody tr):not([data-bucket="hold"]){
  display:none;
}
.studio-page:has(#filter-pass:checked):not(:has(.candidate[data-eligible="true"])) .filter-empty,
.studio-page:has(#filter-pending:checked):not(:has(.candidate[data-bucket="pending"])) .filter-empty,
.studio-page:has(#filter-hold:checked):not(:has(.candidate[data-bucket="hold"])) .filter-empty{
  display:block;
}
.studio-page:has(#filter-pass:checked):not(:has(.candidate[data-eligible="true"])) :is(.exhibition-reel,.matrix-block),
.studio-page:has(#filter-pending:checked):not(:has(.candidate[data-bucket="pending"])) :is(.exhibition-reel,.matrix-block),
.studio-page:has(#filter-hold:checked):not(:has(.candidate[data-bucket="hold"])) :is(.exhibition-reel,.matrix-block){
  display:none;
}

@container (width < 42.5rem){
  .matrix-table,.matrix-table thead,.matrix-table tbody,.matrix-table tr,.matrix-table th,.matrix-table td{display:block}
  .matrix-table thead{display:none}
  .matrix-table tr{padding:.85rem 0;border-bottom:1px solid var(--hairline-strong)}
  .matrix-table tbody th{position:static;padding:0 0 .4rem;border-bottom:0}
  .matrix-table td,.matrix-table .num-col{border-bottom:0;padding:.28rem 0;display:flex;justify-content:space-between;align-items:baseline;gap:.75rem;text-align:right;white-space:normal}
  .matrix-table td::before{flex-shrink:0;white-space:nowrap;color:var(--muted)}
  .matrix-table td.matrix-check{flex-direction:column;align-items:flex-start;text-align:left;gap:.15rem;max-width:none}
  .matrix-table{
    --m2:"结论";--m3:"美站参照价";--m4:"1688百套含运";--m5:"广告前毛利";
    --m6:"扣15%广告后";--m7:"单件贡献";--m8:"21项总分";--m9:"采购前头号核查";
  }
  .matrix-table td:nth-child(2)::before{content:var(--m2)}
  .matrix-table td:nth-child(3)::before{content:var(--m3)}
  .matrix-table td:nth-child(4)::before{content:var(--m4)}
  .matrix-table td:nth-child(5)::before{content:var(--m5)}
  .matrix-table td:nth-child(6)::before{content:var(--m6)}
  .matrix-table td:nth-child(7)::before{content:var(--m7)}
  .matrix-table td:nth-child(8)::before{content:var(--m8)}
  .matrix-table td:nth-child(9)::before{content:var(--m9)}
}

@media(max-width:72rem){
  .exhibition-reel{grid-template-columns:repeat(2,minmax(0,1fr))}
  .plinth-item.is-stagger{margin-top:0}
  .split-stage{grid-template-columns:1fr;gap:2.25rem}
  .stage-hairline{height:1px;width:100%}
  .mh-right{align-items:flex-start}
}
@media(max-width:45rem){
  .studio-page{padding:2rem 1.25rem 4.5rem}
  .polar-wrap{grid-template-columns:1fr}
  .polar-group-summary{grid-template-columns:1fr}
  .kv-row{grid-template-columns:1fr;gap:.2rem}
  .waterfall-table th:first-child{max-width:9rem;white-space:normal}
}
@media(max-width:30rem){
  .exhibition-reel{grid-template-columns:1fr}
}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}
}
@media print{
  body{background:#fff;color:#000;font-size:9.5pt}
  .studio-page{padding:0}
  .typo-nav,.queue-nav,.segmented-track,.exhibition-reel,.skip-link{display:none!important}
  .split-stage{display:block}
  .stage-hairline{display:none}
  .tab-panel{display:block!important;padding-top:10pt}
  details::details-content{display:block;content-visibility:visible}
  details>*{display:block!important}
  .item-qualifier{display:block!important}
}
`;

export const R58_AI_SECTIONS_CSS = `
.inline-score-status{padding:0.75rem 0}
.state-muted{color:#383a42}
.state-muted .dot{background:#383a42}
.rt-audit .rt-head{margin-bottom:0.35rem}
.rt-meta-row{
  display:flex;
  align-items:baseline;
  flex-wrap:wrap;
  gap:0.45rem 0.65rem;
  font-size:0.90625rem;
  color:#1c1d22;
}
.rt-reviewer{color:#0f0f12;font-weight:560}
.rt-dispositions{
  margin-top:0.75rem;
  padding:0.75rem 0;
  border-top:1px solid var(--hairline);
  border-bottom:1px solid var(--hairline);
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  flex-wrap:wrap;
  gap:0.4rem 1rem;
  font-size:0.875rem;
}
.rt-disp-label{color:#383a42;font-weight:540}
.rt-disp-stats{display:inline-flex;align-items:baseline;flex-wrap:wrap;gap:0.45rem;color:#1c1d22;font-weight:520}
.rt-conclusion{
  margin-top:0.75rem;
  font-size:0.9375rem;
  line-height:1.72;
  color:#0f0f12;
  max-width:64ch;
}
.rt-subblock{margin-top:0.85rem}
.rt-subheading{
  display:block;
  font-size:0.90625rem;
  font-weight:580;
  color:#0f0f12;
  margin-bottom:0.35rem;
}
.rt-list{padding-inline-start:1.15em;margin:0;font-size:0.90625rem;line-height:1.68;color:#1c1d22}
.rt-list li+li{margin-top:0.4rem}
.rt-conflict-id{
  color:var(--vermilion);
  font-weight:580;
  text-decoration:underline;
  text-decoration-color:rgba(196,43,0,.38);
  text-underline-offset:0.22em;
}
.rt-item-lead{color:#0f0f12;font-weight:560}
.concept-plinth-section{
  margin-top:2.25rem;
  padding-top:1.5rem;
  border-top:1px solid var(--hairline);
}
.concept-plinth-grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(min(100%,15.5rem),1fr));
  gap:1.5rem;
  margin-top:0.85rem;
}
.concept-plinth-card{margin:0;display:flex;flex-direction:column}
.concept-plinth-stage{
  aspect-ratio:4/3;
  display:grid;
  place-items:center;
  padding:0.75rem;
  background:var(--plinth);
  border-radius:3px;
  overflow:hidden;
}
.concept-plinth-stage img{
  display:block;
  width:100%;
  height:100%;
  object-fit:contain;
  transition:transform .45s var(--ease);
}
@media(hover:hover){
  .concept-plinth-stage:hover img{transform:scale(1.035)}
}
.concept-plinth-meta{padding-top:0.85rem}
.cp-title-row{display:flex;align-items:baseline;gap:0.55rem;flex-wrap:wrap}
.cp-title{flex:1;min-width:8rem;font-size:0.9375rem;font-weight:560;color:#0f0f12}
.cp-caption{margin-top:0.3rem;font-size:0.875rem;line-height:1.62;color:#383a42;max-width:60ch}
.lb-caption{margin-top:0.85rem;font-size:0.875rem;line-height:1.6;color:#383a42}
@media print{
  .css-lightbox{display:none!important}
}
`;

