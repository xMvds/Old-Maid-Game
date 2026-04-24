(function(){
  const el = document.getElementById('playerBgC');
  if(!el) return;
  if(typeof window.FinisherHeader !== 'function') return;

  // Match Theater Balance Scale vibe (soft grey particles, lighten blend)
  const cfg = {
    count: 6,
    size: { min: 207, max: 304, pulse: 0.5 },
    speed: { x: { min: 0, max: 0.1 }, y: { min: 0, max: 0.2 } },
    colors: { background: '#0b0d12', particles: ['#3b3c46'] },
    blending: 'lighten',
    opacity: { center: 0.06, edge: 0 },
    skew: 0,
    shapes: ['c']
  };

  try{
    el.style.background = cfg.colors.background;
    // eslint-disable-next-line no-new
    new window.FinisherHeader(cfg);
  }catch(e){
    // fail silent
    console && console.warn && console.warn('FinisherHeader init failed', e);
  }
})();
