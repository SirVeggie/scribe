/** Dock appearance experiment. Remove this module and its settings hook to return to the CSS orb. */
(() => {
  const appearanceStorage = window.scribeAppearance || localStorage;
  const PALETTES = {
    ocean: ["#061a33", "#0b5e8a", "#22b8cf", "#d6f6ff"],
    ember: ["#2a0a06", "#a8321a", "#f08a2c", "#ffe1a6"],
    moonstone: ["#15171c", "#3c4250", "#a3abb9", "#f4f6fa"],
    sky: ["#0d2a5c", "#3b82f6", "#93c5fd", "#fff7d6"],
  };
  const PROVIDERS = { claude: "Claude", cursor: "Cursor", codex: "Codex", pi: "Native" };
  const STYLES = { liquid3d: "Liquid sphere", mesh: "Mesh gradient", meshquick: "Mesh gradient (quick)", ring: "Ring", ink: "Ink in water", plasma: "Plasma", halftone: "Halftone", galaxy: "Spiral galaxy", none: "None" };
  // Shape animation speed while idle and working; others use [.6, 2].
  const SPEEDS = { meshquick: [1, 1.3], plasma: [.5, 1.1] };
  const SYMBOLS = { none: "Colour only", glow: "Glowing symbol", traced: "Traced outline", crt: "CRT", dots: "LED matrix" };
  const BLEEDS = { none: "None", dye: "Dye in the surface", flares: "Solar flares", galaxy: "Spiral wake", glow: "Glow", waveDots: "Dot waves", pulse: "Gradient pulse", motes: "Drifting motes" };
  const ICON_PALETTES = {
    white: ["#e0eaff", "#ffffff"],
    ice: ["#7ee7ff", "#ffffff"],
    amber: ["#ffc168", "#fff3d6"],
    ink: ["#111827", "#334155"],
  };
  const KEY = "scribe.dock-appearance.v1";
  // Desktop choices migrated to the daemon, adopted as built-in defaults (#561).
  const PROVIDER_DEFAULTS = {
    claude: { style: "mesh", symbol: "none", bleed: "glow", iconColors: ["#ff9100", "#ffb300"], iconSize: .7, colors: PALETTES.ember },
    cursor: { style: "none", symbol: "crt", bleed: "waveDots", iconColors: ICON_PALETTES.white, iconSize: 1, colors: PALETTES.moonstone },
    codex: { style: "none", symbol: "crt", bleed: "dye", iconColors: ICON_PALETTES.white, iconSize: .85, colors: ["#0d2a5c", "#3b82f6", "#62abfe", "#ffffff"] },
    pi: { style: "galaxy", symbol: "glow", bleed: "galaxy", iconColors: ICON_PALETTES.white, iconSize: .85, colors: PALETTES.ocean },
  };
  const defaults = (provider) => {
    const base = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.pi;
    return { ...base, iconColors: [...base.iconColors], colors: [...base.colors] };
  };
  function clean(value, provider) {
    const base = defaults(provider);
    if (!value || typeof value !== "object") return base;
    for (const [key, options] of [["style", STYLES], ["symbol", SYMBOLS], ["bleed", BLEEDS]]) {
      if (Object.hasOwn(options, value[key])) base[key] = value[key];
    }
    if (Array.isArray(value.colors) && value.colors.length === 4 && value.colors.every(c => /^#[0-9a-f]{6}$/i.test(c))) base.colors = [...value.colors];
    if (Array.isArray(value.iconColors) && value.iconColors.length === 2 && value.iconColors.every(c => /^#[0-9a-f]{6}$/i.test(c))) base.iconColors = [...value.iconColors];
    if (typeof value.iconSize === "number" && Number.isFinite(value.iconSize)) base.iconSize = Math.max(.5, Math.min(1.1, value.iconSize));
    // Keep saved choices meaningful after moving flares from shapes to surface effects.
    if (value.style === "flares") { base.style = "mesh"; base.bleed = "flares"; }
    if (value.bleed === "breathing") base.bleed = "glow";
    if (value.bleed === "circuit" && value.style !== "flares") base.bleed = "none";
    return base;
  }
  function read() {
    let saved;
    try { saved = JSON.parse(appearanceStorage.getItem(KEY)); } catch {}
    return Object.fromEntries(Object.keys(PROVIDERS).map(p => [p, clean(saved?.[p], p)]));
  }
  let settings = read();
  window.addEventListener("scribe:appearance", () => {
    settings = read();
    window.dispatchEvent(new Event("scribe:orb-appearance"));
  });
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  const FRAG = `precision highp float;
uniform vec2 u_res;uniform float u_time;uniform float u_shapeTime;uniform float u_energy;uniform float u_prov;uniform float u_bleed;
uniform vec3 u_c0;uniform vec3 u_c1;uniform vec3 u_c2;uniform vec3 u_c3;uniform vec3 u_i0;uniform vec3 u_i1;uniform float u_iconSize;
#define PI 3.14159265
#define TAU 6.2831853
float px;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float h1(float n){return fract(sin(n*12.9898)*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<4;i++){v+=a*noise(p);p=m*p;a*=.5;}return v;}
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,s,-s,c);}
vec3 pal(float t){t=clamp(t,0.,1.)*3.;if(t<1.)return mix(u_c0,u_c1,t);if(t<2.)return mix(u_c1,u_c2,t-1.);return mix(u_c2,u_c3,t-2.);}
vec3 rainbow(float t){return .55+.45*cos(TAU*(t+vec3(0.,.33,.67)));}
float aaIn(float d){return 1.-smoothstep(-px,px,d);}
vec4 pm(vec3 c,float a){return vec4(clamp(c,0.,1.)*a,a);}
vec4 over(vec4 a,vec4 b){return a+b*(1.-a.a);}
float sphZ(vec2 uv){return sqrt(max(0.,1.-dot(uv,uv)));}
vec3 lit(vec3 col,vec2 uv,float rim){float z=sphZ(uv);vec3 n=vec3(uv,z);vec3 L=normalize(vec3(-.5,.6,.8));
col*=.55+.6*max(dot(n,L),0.);col+=vec3(1.)*pow(max(dot(reflect(-L,n),vec3(0.,0.,1.)),0.),20.)*.5;
col+=mix(u_c3,vec3(1.),.3)*pow(1.-z,2.6)*rim*(.6+.4*u_energy);return col;}
float liquid(vec2 uv,float t,out vec2 q){float a=t*.5+(1.-length(uv))*1.8;vec2 p=rot(a)*uv;
q=vec2(fbm(p*1.7+vec2(t*.6,0.)),fbm(p*1.7+vec2(3.1,-t*.5)));return fbm(p*1.9+2.6*q+vec2(-t*.3,t*.25));}
float liqT(vec2 uv,float t){vec2 q;float f=liquid(uv,t,q);return clamp(f*1.25-.2+(q.x-.5)*.6,0.,1.);}
vec4 flatDisc(vec2 uv,float t){float r=length(uv);float a=aaIn(r-1.);if(a<=0.)return vec4(0.);return pm(pal(liqT(uv,t*.4)),a);}
float sdSeg(vec2 p,vec2 a,vec2 b){vec2 pa=p-a,ba=b-a;float h=clamp(dot(pa,ba)/dot(ba,ba),0.,1.);return length(pa-ba*h);}
float sdHex(vec2 p,float r){const vec3 k=vec3(-.866025404,.5,.577350269);p=abs(p);p-=2.*min(dot(k.xy,p),0.)*k.xy;p-=vec2(clamp(p.x,-k.z*r,k.z*r),r);return length(p)*sign(p.y);}
float symClaude(vec2 p){float d=1e5;float taper=1.-.4*smoothstep(0.,.8,length(p));
for(int i=0;i<6;i++){float fi=float(i);float a=fi*PI/6.+.13;vec2 dir=vec2(cos(a),sin(a));
float l1=.6+.25*h1(fi),l2=.6+.25*h1(fi+7.);d=min(d,sdSeg(p,-dir*l1,dir*l2)-.1*taper);}return d;}
float symCursor(vec2 p){float h=abs(sdHex(p.yx,.56))-.07;vec2 c=vec2(0.,0.);
float y=min(min(sdSeg(p,c,vec2(0.,-.62)),sdSeg(p,c,vec2(.55,.32))),sdSeg(p,c,vec2(-.55,.32)))-.06;return min(h,y);}
float symCodex(vec2 p){p+=vec2(.04,0.);float d=min(sdSeg(p,vec2(-.48,.34),vec2(-.1,0.)),sdSeg(p,vec2(-.1,0.),vec2(-.48,-.34)));
d=min(d,sdSeg(p,vec2(.08,-.36),vec2(.5,-.36)));return d-.085;}
float symPi(vec2 p){float d=sdSeg(p,vec2(-.52,.36),vec2(.52,.4));d=min(d,sdSeg(p,vec2(-.2,.38),vec2(-.3,-.46)));
d=min(d,sdSeg(p,vec2(.2,.38),vec2(.2,-.34)));d=min(d,sdSeg(p,vec2(.2,-.34),vec2(.36,-.46)));return d-.08;}
float sym(vec2 p){if(u_prov<.5)return symClaude(p);if(u_prov<1.5)return symCursor(p);if(u_prov<2.5)return symCodex(p);return symPi(p);}

uniform float u_style;uniform float u_work;uniform float u_symbol;uniform float u_surface;uniform float u_bleedmode;
vec4 liquid3d(vec2 uv,float t){float r=length(uv);float a=aaIn(r-1.);if(a<=0.)return vec4(0.);float z=sphZ(uv);
vec3 col=pal(liqT(uv*(1.1+.4*(1.-z)),t*.4));col=mix(u_c0,col,.45+.55*z);return pm(lit(col,uv,1.),a);}
vec4 mesh(vec2 uv,float t){float r=length(uv);float a=aaIn(r-1.);if(a<=0.)return vec4(0.);t*=.5;
vec2 p0=.6*vec2(sin(t*.7),cos(t*.9)),p1=.6*vec2(sin(t*.8+2.),cos(t*.6+1.)),p2=.6*vec2(sin(t*.5+4.),cos(t*.75+3.)),p3=.6*vec2(sin(t*.65+1.),cos(t*.85+5.));
float w0=exp(-4.*dot(uv-p0,uv-p0)),w1=exp(-4.*dot(uv-p1,uv-p1)),w2=exp(-4.*dot(uv-p2,uv-p2)),w3=exp(-4.*dot(uv-p3,uv-p3));
vec3 col=(u_c0*w0+u_c1*w1+u_c2*w2+u_c3*w3+u_c1*.05)/(w0+w1+w2+w3+.05);return pm(col,a);}
vec4 meshquick(vec2 uv,float t){float r=length(uv);float a=aaIn(r-1.);if(a<=0.)return vec4(0.);t*=.5;float k=mix(4.,10.,u_work);
vec2 p0=.6*vec2(sin(t*.7),cos(t*.9)),p1=.6*vec2(sin(t*.8+2.),cos(t*.6+1.)),p2=.6*vec2(sin(t*.5+4.),cos(t*.75+3.)),p3=.6*vec2(sin(t*.65+1.),cos(t*.85+5.));
vec2 p4=.55*vec2(sin(t*.9+3.),cos(t*.7+2.)),p5=.55*vec2(sin(t*.6+5.),cos(t*.95+4.)),p6=.55*vec2(sin(t*.85+1.5),cos(t*.55+6.)),p7=.55*vec2(sin(t*.75+.5),cos(t*.8+3.5));
float off=(1.-u_work)*3.;
float d0=dot(uv-p0,uv-p0),d1=dot(uv-p1,uv-p1),d2=dot(uv-p2,uv-p2),d3=dot(uv-p3,uv-p3);
float d4=dot(uv-p4,uv-p4)+off,d5=dot(uv-p5,uv-p5)+off,d6=dot(uv-p6,uv-p6)+off,d7=dot(uv-p7,uv-p7)+off;
// Measure from the nearest blob so some colour always fills every pixel.
float dm=min(min(min(d0,d1),min(d2,d3)),min(min(d4,d5),min(d6,d7)));
float w0=exp(-k*(d0-dm)),w1=exp(-k*(d1-dm)),w2=exp(-k*(d2-dm)),w3=exp(-k*(d3-dm));
float w4=exp(-k*(d4-dm)),w5=exp(-k*(d5-dm)),w6=exp(-k*(d6-dm)),w7=exp(-k*(d7-dm));
vec3 cs=u_c0*w0+u_c1*w1+u_c2*w2+u_c3*w3+u_c2*w4+u_c3*w5+u_c0*w6+u_c1*w7;
return pm(cs/(w0+w1+w2+w3+w4+w5+w6+w7),a);}
vec4 ring(vec2 uv,float t){float r=length(uv);float w=.17;float d=abs(r-.8)-w;float a=aaIn(d);if(a<=0.)return vec4(0.);
float ang=atan(uv.y,uv.x)/TAU;float k=fract(ang+t*.12+.25*fbm(uv*2.5+vec2(t*.3,0.)));vec3 col=pal(abs(k*2.-1.));
float x=clamp((r-.8)/w,-1.,1.);float z=sqrt(1.-x*x);col*=.6+.5*z;col+=vec3(.6)*pow(z,12.)*smoothstep(0.,.5,uv.y+.3)*.5;return pm(col,a);}
vec4 ink(vec2 uv,float t){float r=length(uv);float a=aaIn(r-1.);if(a<=0.)return vec4(0.);vec2 p=uv*1.4;t*=.3;
vec2 q=vec2(fbm(p+vec2(0.,t)),fbm(p+vec2(5.2,1.3)-t*.8));vec2 w=vec2(fbm(p+3.*q+vec2(1.7,9.2)+t*.6),fbm(p+3.*q+vec2(8.3,2.8)-t*.5));
float f=fbm(p+3.2*w);vec3 col=mix(u_c0,u_c1,smoothstep(.2,.5,f));col=mix(col,u_c2,smoothstep(.4,.65,f));col=mix(col,u_c3,smoothstep(.55,.8,f));return pm(col,a);}
vec4 plasma(vec2 uv,float t){float r=length(uv);float a=aaIn(r-1.);if(a<=0.)return vec4(0.);vec2 p=uv*3.;
float v=sin(p.x+t)+sin(p.y*.8-t*1.3)+sin((p.x+p.y)*.7+t*.7)+sin(length(p+vec2(sin(t*.5),cos(t*.4)))*1.5-t*1.5);
return pm(pal(.5+.5*sin(v*1.1)),a);}
vec4 halftone(vec2 uv,float t){float r=length(uv);float a=aaIn(r-1.);if(a<=0.)return vec4(0.);float n=7.;vec2 g=uv*n;vec2 id=floor(g)+.5;
float v=liqT(id/n,t*.4);float rad=.12+.4*v;float dd=length(g-id)-rad;float dm=1.-smoothstep(-px*n,px*n,dd);vec3 col=mix(u_c0*.7,pal(v),dm);return pm(col,a);}
vec4 galaxy(vec2 uv,float t){float r=length(uv)+.001;float ang=atan(uv.y,uv.x);float arm=pow(.5+.5*sin(2.*ang-log(r)*5.+t*(.6+u_energy)),3.);
float n=fbm(uv*3.+vec2(t*.1));float dens=clamp(arm*(.4+.8*n)*exp(-r*1.4)*1.8+exp(-r*6.)*1.2,0.,1.);
vec3 col=mix(pal(.4+.5*n),u_c3,exp(-r*5.));return pm(col,dens*smoothstep(1.6,1.1,r));}

vec4 base(vec2 uv,float t){
if(u_style<.5)return liquid3d(uv,t);if(u_style<1.5)return mesh(uv,t);if(u_style<2.5)return meshquick(uv,t);if(u_style<3.5)return ring(uv,t);
if(u_style<4.5)return ink(uv,t);if(u_style<5.5)return plasma(uv,t);if(u_style<6.5)return halftone(uv,t);
if(u_style<7.5)return galaxy(uv*1.6,t);return vec4(0.);
}
vec4 mark(vec2 uv,float t){
float d=sym(uv/u_iconSize)*u_iconSize;float inside=aaIn(d);float a=0.;vec3 c=mix(u_i0,u_i1,.7);
if(u_symbol<1.5){a=inside*.95+exp(-max(d,0.)*20.)*.3;c=mix(u_i0,u_i1,liqT(uv,t*.5));}
else if(u_symbol<2.5){float angle=atan(uv.y,uv.x)-t*2.2;float band=pow(.5+.5*cos(angle),10.)+pow(.5-.5*cos(angle),10.);
a=inside*.3+exp(-abs(d)*40.)*(.75+.25*band);c=mix(u_i0,u_i1,clamp(band,0.,1.));}
else if(u_symbol<3.5){float scan=.65+.35*sin(uv.y*45.);float roll=1.+.2*exp(-abs(fract(uv.y*.35-t*.25)-.5)*30.);
a=(inside+exp(-max(d,0.)*20.)*.25)*scan*roll;}
else {float n=8.;vec2 g=uv*n,id=floor(g)+.5;float on=step(sym(id/n/u_iconSize),.04);
float dotmask=1.-smoothstep(.3-px*n,.3+px*n,length(g-id));
a=on*dotmask*(.8+.2*sin(t*3.+hash(id)*TAU));}
return pm(c,clamp(a,0.,1.)*(1.-smoothstep(1.,1.2,length(uv))));
}
vec4 surface(vec2 uv,float t){
float r=length(uv);float reach=exp(-r*.55);float n=liqT(uv*.7,t*.4);float a=0.;
if(u_bleedmode<1.5){a=smoothstep(.25,.8,n)*reach*.42;}
else if(u_bleedmode<2.5){vec2 dir=uv/max(r,.001);
float f=.6*fbm(dir*2.2+vec2(t*.35,t*.2))+.4*fbm(dir*5.+vec2(-t*.6,t*.4));
float h=.18+1.2*pow(f,2.4)*(.6+.8*u_energy);
a=pow(clamp(1.-max(r-.92,0.)/h,0.,1.),1.5)*smoothstep(.72,1.,r)*.75;}
else if(u_bleedmode<3.5){float arm=pow(.5+.5*sin(atan(uv.y,uv.x)*2.-log(r+.01)*5.+t*.6),5.);
a=arm*reach*.55;}
else if(u_bleedmode<4.5){float breath=.5+.5*sin(t*1.8);
a=mix(exp(-r*r*.35)*.36,exp(-r*r/(2.2+2.2*breath))*(.18+.28*breath),u_work);}
else if(u_bleedmode<5.5){vec2 g=uv*3.,id=floor(g)+.5;
float dotmask=1.-smoothstep(.2,.36,length(g-id));
float wave=pow(.5+.5*cos(length(id/3.)*3.3-t*3.3),3.);
a=dotmask*exp(-length(id/3.)*.42)*(.08+.8*wave);}
else if(u_bleedmode<6.5){float phase=fract(t*.35);float R=.8+phase*6.;
a=exp(-pow((r-R)/((.55+phase*.7)*mix(1.7,1.,u_work)),2.))*smoothstep(0.,.3,phase)*(1.-phase)*.5+exp(-r*r*.6)*.1;}
else {for(int i=0;i<12;i++){float fi=float(i);float phase=fract(t*(.12+.06*h1(fi))+h1(fi+2.));
vec2 p=vec2(.7+phase*7.,(h1(fi+8.)-.5)*2.+.2*sin(t*.7+fi));
float d=length(uv-p);float fade=smoothstep(0.,.12,phase)*(1.-smoothstep(.45,1.,phase));
a+=(exp(-d*24.)+exp(-d*7.)*.15)*fade*.65;}}
a*=1.-smoothstep(5.,8.,uv.x);
vec3 color=u_bleedmode>3.5?mix(u_c2,u_c3,.45):pal(.4+.5*n);
return pm(color,clamp(a*(.65+.35*u_energy),0.,1.));
}
void main(){
float s=.5*min(u_res.x,u_res.y);px=1./s;
if(u_surface>.5){vec2 uv=(gl_FragCoord.xy-vec2(23.)*u_res.x/160.)/(15.*u_res.x/160.);
gl_FragColor=u_bleedmode<.5?vec4(0.):surface(uv,u_time);return;}
vec2 uv=(gl_FragCoord.xy-.5*u_res)/s*u_bleed;px=u_bleed/s;
vec4 c=base(uv,u_shapeTime);
float r=length(uv);
if(u_style<6.5){
c*=1.-smoothstep(.9,1.05,r);
float edge=exp(-abs(r-.97)*15.)*(1.-smoothstep(1.,1.26,r))*.22;
c=over(c,pm(mix(u_c2,u_c3,.35),edge));}
if(u_symbol>.5){
// Give bright icons a dark underlay, and dark icons a light one.
float d=sym(uv/u_iconSize)*u_iconSize;
float shadow=exp(-max(d,0.)*18.)*.6*(1.-smoothstep(1.,1.2,r));
float brightness=dot(mix(u_i0,u_i1,.7),vec3(.2126,.7152,.0722));
vec3 backing=mix(vec3(.95,.97,1.),vec3(.01,.015,.025),smoothstep(.25,.65,brightness));
c=over(pm(backing,shadow),c);
c=over(mark(uv,u_time),c);}
gl_FragColor=c;
}
`;
  function create(btn, container, initialProvider = "pi", config) {
    const canvas = document.createElement("canvas");
    canvas.className = "dock-orb-canvas";
    canvas.setAttribute("aria-hidden", "true");
    btn.prepend(canvas);
    const surface = document.createElement("canvas");
    surface.className = "dock-orb-surface";
    surface.setAttribute("aria-hidden", "true");
    container.prepend(surface);
    const opts = { alpha: true, scale: () => Math.min(2, window.devicePixelRatio || 1) };
    const fx = window.scribeGL?.lazy(canvas, FRAG, {
      ...opts, onReady: () => btn.classList.add("gl"),
      onError: () => {
        broken = true; loop.stop(); spill?.destroy();
        btn.classList.remove("gl", "fx-live"); canvas.remove(); surface.remove();
        const error = container.closest(".orb-settings")?.querySelector(".orb-settings-error");
        if (error) error.textContent = "WebGL is unavailable. The chat uses the gradient fallback.";
      },
    });
    const spill = fx && window.scribeGL.lazy(surface, FRAG, opts);
    if (!fx) { canvas.remove(); surface.remove(); return null; }
    if (!spill) surface.remove();
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    let provider = initialProvider, current = config || settings[provider] || defaults(provider);
    let time = 12, shapeTime = 12, work = 0, busy = false, disposed = false, broken = false;
    const values = () => ({
      u_time: time, u_shapeTime: shapeTime, u_energy: busy ? 1 : 0, u_work: work,
      u_prov: Math.max(0, Object.keys(PROVIDERS).indexOf(provider)),
      u_style: Object.keys(STYLES).indexOf(current.style),
      u_symbol: Object.keys(SYMBOLS).indexOf(current.symbol),
      u_bleedmode: Object.keys(BLEEDS).indexOf(current.bleed),
      u_bleed: 38 / 30,
      u_iconSize: current.iconSize,
      u_i0: hex(current.iconColors[0]), u_i1: hex(current.iconColors[1]),
      ...Object.fromEntries(current.colors.map((c,i) => ["u_c"+i, hex(c)])),
    });
    function draw() {
      const uniforms = values();
      spill?.draw({ ...uniforms, u_surface: 1 });
      return fx.draw({ ...uniforms, u_surface: 0 });
    }
    const loop = window.scribeGL.loop(dt => {
      // The shape has its own clock so its speed does not change the surface or icon.
      const [idle, working] = SPEEDS[current.style] || [.6, 2];
      shapeTime += dt * (busy ? working : idle);
      time += dt * (busy ? 2 : .6);
      work += ((busy ? 1 : 0) - work) * Math.min(1, dt * 3);
      if (!draw()) loop.stop();
    }, { element: btn });
    function update() {
      if (disposed || broken) return;
      const moving = !still.matches && !document.documentElement.classList.contains("fx-off");
      btn.classList.toggle("fx-live", moving);
      if (moving) loop.start();
      else { loop.stop(); draw(); }
    }
    const refresh = () => { if (!config) current = settings[provider] || defaults(provider); update(); };
    window.addEventListener("scribe:ui-fx", update);
    window.addEventListener("scribe:orb-appearance", refresh);
    still.addEventListener("change", update);
    const resize = new ResizeObserver(update);
    resize.observe(canvas);
    resize.observe(container);
    const lost = event => { event.preventDefault(); broken = true; loop.stop(); btn.classList.remove("gl", "fx-live"); canvas.hidden = true; surface.hidden = true; };
    canvas.addEventListener("webglcontextlost", lost);
    update();
    return {
      setBusy(on) { if (busy !== on) { busy = on; update(); } },
      setProvider(next) { if (provider !== next) { provider = next; current = config || settings[provider] || defaults(provider); update(); } },
      setConfig(next, nextProvider = provider) { provider = nextProvider; config = clean(next, provider); current = config; update(); },
      destroy() {
        disposed = true; loop.destroy(); resize.disconnect();
        window.removeEventListener("scribe:ui-fx", update);
        window.removeEventListener("scribe:orb-appearance", refresh);
        still.removeEventListener("change", update);
        canvas.removeEventListener("webglcontextlost", lost);
        fx.destroy(); spill?.destroy(); canvas.remove(); surface.remove(); btn.classList.remove("gl", "fx-live");
      },
    };
  }

  function openSettings() {
    if (document.querySelector(".orb-settings")) return;
    let draft = read(), provider = "claude", previewFx;
    const dialog = document.createElement("dialog");
    dialog.className = "orb-settings";
    dialog.setAttribute("aria-labelledby", "orb-settings-title");
    const node = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
    const title = node("h2", "Floating chat appearance");
    title.id = "orb-settings-title";
    const help = node("button", "?", "orb-settings-help");
    help.type = "button";
    help.dataset.tooltip = "Each provider keeps its own look. Changes are saved on this device.";
    help.setAttribute("aria-label", "About floating chat appearance");
    help.setAttribute("aria-description", help.dataset.tooltip);
    const heading = node("div", null, "orb-settings-heading");
    heading.append(title, help);

    /** A segmented track of text buttons (app.css .button-track). */
    function track(options, pick) {
      const wrap = node("div", null, "button-track text-track");
      wrap.setAttribute("role", "group");
      const buttons = Object.entries(options).map(([value, text]) => {
        const b = node("button", text); b.type = "button"; b.dataset.value = value;
        b.addEventListener("click", () => pick(value)); wrap.append(b); return b;
      });
      wrap.sync = (value) => buttons.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.value === value)));
      return wrap;
    }
    const providers = track(PROVIDERS, (value) => { provider = value; paint(); });
    providers.setAttribute("aria-label", "Provider");
    heading.append(providers);

    // The preview on the left, the chosen provider's settings on the right.
    const stage = node("div", null, "orb-settings-stage");
    const preview = node("div", null, "dock-input orb-settings-preview");
    const orb = node("button", null, "dock-orb"); orb.type = "button"; orb.setAttribute("aria-label", "Appearance preview");
    preview.append(orb, node("span", "Message your agent…", "orb-preview-text"));
    const busy = node("button", null, "pill-toggle"); busy.type = "button";
    busy.setAttribute("role", "switch"); busy.setAttribute("aria-checked", "false");
    busy.setAttribute("aria-label", "Preview while working");
    const busyRow = node("div", null, "orb-settings-busy");
    const busyLabel = node("span", "Working");
    busyLabel.addEventListener("click", () => busy.click());
    busyRow.append(busyLabel, busy);
    stage.append(preview, busyRow);

    const form = node("div", null, "orb-settings-form");
    const body = node("div", null, "orb-settings-body");
    body.append(stage, form);
    dialog.append(heading, body);

    const selects = [];
    function section(name) {
      const s = node("section", null, "orb-settings-section");
      s.append(node("h3", name)); form.append(s); return s;
    }
    function row(parent, label, control) {
      const wrap = node("div", null, "setting-row");
      control.setAttribute("aria-label", label);
      wrap.append(node("span", label), control); parent.append(wrap);
      if (control.tagName === "SELECT") selects.push(window.createSelect(control));
      return control;
    }
    function select(options) {
      const sel = node("select");
      for (const [value, text] of Object.entries(options)) { const opt = node("option", text); opt.value = value; sel.append(opt); }
      return sel;
    }
    /** Preset swatches, then colour wells; editing a well makes the palette custom. */
    function swatches(presets, names, onPreset) {
      const wrap = node("div", null, "orb-swatches");
      wrap.setAttribute("role", "group");
      const buttons = Object.entries(presets).map(([name, cols]) => {
        const b = node("button", null, "orb-swatch"); b.type = "button"; b.dataset.value = name;
        const label = name[0].toUpperCase() + name.slice(1);
        b.setAttribute("aria-label", label); b.dataset.tooltip = label;
        const stops = cols.map((c, i) => `${c} ${Math.round(i * 100 / (cols.length - 1))}%`).join(", ");
        b.style.setProperty("--sw", `linear-gradient(135deg, ${stops})`);
        b.addEventListener("click", () => onPreset(name)); wrap.append(b); return b;
      });
      const wells = node("div", null, "orb-wells");
      const inputs = names.map(n => {
        const input = node("input"); input.type = "color"; input.setAttribute("aria-label", n); input.dataset.tooltip = n;
        wells.append(input); return input;
      });
      wrap.append(wells);
      wrap.sync = (cols) => {
        const match = Object.keys(presets).find(p => presets[p].every((v, i) => v.toLowerCase() === cols[i].toLowerCase()));
        buttons.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.value === match)));
        wells.classList.toggle("custom", !match);
        inputs.forEach((n, i) => { n.value = cols[i]; });
      };
      wrap.inputs = inputs;
      return wrap;
    }

    const shapeSec = section("Shape");
    const style = row(shapeSec, "Style", select(STYLES));
    const palette = row(shapeSec, "Colours", swatches(PALETTES, ["Deep colour", "Mid colour", "Bright colour", "Highlight"],
      (name) => { draft[provider].colors = [...PALETTES[name]]; paint(); }));
    const surfaceSec = section("Chat surface");
    const bleed = row(surfaceSec, "Effect", select(BLEEDS));
    const iconSec = section("Provider icon");
    const symbol = row(iconSec, "Display", select(SYMBOLS));
    const iconPalette = row(iconSec, "Colours", swatches(ICON_PALETTES, ["Icon base colour", "Icon highlight"],
      (name) => { draft[provider].iconColors = [...ICON_PALETTES[name]]; paint(); }));
    const sizeWrap = node("div", null, "orb-settings-size");
    const size = node("input", null, "orb-range"); size.type = "range"; size.min = "50"; size.max = "110"; size.step = "5";
    const sizeValue = node("output"); sizeValue.setAttribute("aria-hidden", "true");
    sizeWrap.append(size, sizeValue); row(iconSec, "Size", sizeWrap);
    size.setAttribute("aria-label", "Icon size");
    const error = node("p", null, "orb-settings-error"); error.setAttribute("role", "alert"); form.append(error);

    function paint() {
      const c = draft[provider];
      providers.sync(provider); style.value = c.style; symbol.value = c.symbol; bleed.value = c.bleed;
      palette.sync(c.colors);
      iconPalette.sync(c.iconColors);
      size.value = String(Math.round(c.iconSize * 100)); sizeValue.textContent = size.value + "%";
      size.setAttribute("aria-valuetext", sizeValue.textContent);
      size.style.setProperty("--fill", ((size.value - size.min) / (size.max - size.min) * 100) + "%");
      selects.forEach(s => s.syncSelect());
      previewFx?.setConfig(c, provider);
    }
    for (const [sel,key] of [[style,"style"],[symbol,"symbol"],[bleed,"bleed"]]) sel.addEventListener("change", () => { draft[provider][key] = sel.value; paint(); });
    palette.inputs.forEach((input,i) => input.addEventListener("input", () => { draft[provider].colors[i] = input.value; paint(); }));
    iconPalette.inputs.forEach((input,i) => input.addEventListener("input", () => { draft[provider].iconColors[i] = input.value; paint(); }));
    size.addEventListener("input", () => { draft[provider].iconSize = Number(size.value) / 100; paint(); });
    busy.addEventListener("click", () => {
      const on = busy.getAttribute("aria-checked") !== "true";
      busy.setAttribute("aria-checked", String(on));
      preview.classList.toggle("busy", on); previewFx?.setBusy(on);
    });
    const actions = node("div", null, "orb-settings-actions");
    function action(text, run, cls) { const b = node("button", text, cls); b.type = "button"; b.addEventListener("click", run); actions.append(b); }
    action("Reset provider", () => { draft[provider] = defaults(provider); paint(); });
    action("Cancel", () => dialog.close());
    action("Save", () => {
      try { appearanceStorage.setItem(KEY, JSON.stringify(draft)); }
      catch { error.textContent = "Could not save these settings on this device."; return; }
      settings = draft; window.dispatchEvent(new Event("scribe:orb-appearance")); dialog.close();
    }, "primary");
    dialog.append(actions);
    dialog.addEventListener("close", () => { previewFx?.destroy(); dialog.remove(); }, { once: true });
    dialog.addEventListener("click", e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
    document.body.append(dialog); dialog.showModal();
    previewFx = create(orb, preview, provider, draft[provider]); paint();
    // Start on the provider choice, not the ? button (focus would pop its tooltip).
    providers.querySelector('[aria-pressed="true"]')?.focus({ focusVisible: false });
    if (!previewFx) error.textContent = "WebGL is unavailable. The chat uses the gradient fallback.";
  }
  document.getElementById("dock-appearance")?.addEventListener("click", openSettings);
  window.scribeOrb = { create, openSettings, colors: (provider) => [...(settings[provider] || defaults(provider)).colors] };
})();

