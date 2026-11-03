(() => {
  // Reading the page runs the 24-hour wait: each stamp lands as its section reaches mid-screen.
  const clock = document.getElementById('clock');
  const crawl = document.getElementById('crawl');
  const stamps = [...document.querySelectorAll('#wait article')].map((el) => {
    const [h, m] = el.querySelector('time').textContent.split(':').map(Number);
    return { el, s: h * 3600 + m * 60 };
  });
  const DAY = 86400;
  const two = (n) => String(n).padStart(2, '0');
  function tick() {
    const mid = innerHeight / 2;
    let s = 0;
    for (let i = 0; i < stamps.length; i++) {
      const top = stamps[i].el.getBoundingClientRect().top;
      if (top > mid) break;
      const next = stamps[i + 1];
      const nextTop = next ? next.el.getBoundingClientRect().top : top;
      const part = next ? Math.min(1, (mid - top) / (nextTop - top)) : 1;
      s = stamps[i].s + part * ((next?.s ?? DAY) - stamps[i].s);
    }
    s = Math.round(s);
    clock.textContent = `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
    crawl.style.width = `${(s / DAY) * 100}%`;
  }
  addEventListener('scroll', tick, { passive: true });
  addEventListener('resize', tick);
  tick();
})();
