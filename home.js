(() => {
  // Mark body for home-only styles
  document.body.classList.add('home');

  // ── Stars canvas ──────────────────────────────────────
  const canvas = document.getElementById('stars');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    let w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    let stars = [];
    let mx = 0.5, my = 0.5;
    const STAR_COUNT = 200;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = canvas.width = Math.floor(rect.width * dpr);
      h = canvas.height = Math.floor(rect.height * dpr);
    };

    const init = () => {
      stars = [];
      for (let i = 0; i < STAR_COUNT; i++) {
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          z: Math.random() * 0.85 + 0.15,
          r: (Math.random() * 1.3 + 0.25) * dpr,
          vx: (Math.random() - 0.5) * 0.08 * dpr,
          vy: (Math.random() - 0.5) * 0.08 * dpr,
          phase: Math.random() * Math.PI * 2,
          speed: 0.0008 + Math.random() * 0.0016,
        });
      }
    };

    const tick = (t) => {
      ctx.clearRect(0, 0, w, h);
      const px = (mx - 0.5) * 30 * dpr;
      const py = (my - 0.5) * 30 * dpr;
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        s.x += s.vx;
        s.y += s.vy;
        if (s.x < -10) s.x = w + 10;
        if (s.x > w + 10) s.x = -10;
        if (s.y < -10) s.y = h + 10;
        if (s.y > h + 10) s.y = -10;
        const twinkle = 0.45 + 0.55 * Math.sin(s.phase + t * s.speed);
        ctx.globalAlpha = twinkle * (0.4 + s.z * 0.6);
        ctx.fillStyle = '#F5F1E8';
        ctx.beginPath();
        ctx.arc(s.x + px * s.z, s.y + py * s.z, s.r * (0.5 + s.z * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(tick);
    };

    resize();
    init();
    requestAnimationFrame(tick);

    let resizeT;
    window.addEventListener('resize', () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => { resize(); init(); }, 150);
    });
    window.addEventListener('mousemove', (e) => {
      mx = e.clientX / window.innerWidth;
      my = e.clientY / window.innerHeight;
    });
  }

  // ── Navbar scroll state ──────────────────────────────
  const nav = document.querySelector('.navbar');
  const onScroll = () => {
    if (!nav) return;
    if (window.scrollY > window.innerHeight * 0.75) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ── 3D tilt + light follow on module cards ──────────
  document.querySelectorAll('.module-card').forEach((card) => {
    let raf = null;
    const onMove = (e) => {
      const rect = card.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const rx = (0.5 - y) * 6;
      const ry = (x - 0.5) * 6;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        card.style.transform = `translateY(-4px) rotateX(${rx}deg) rotateY(${ry}deg)`;
        card.style.setProperty('--mx', `${x * 100}%`);
        card.style.setProperty('--my', `${y * 100}%`);
      });
    };
    const reset = () => {
      cancelAnimationFrame(raf);
      card.style.transform = '';
    };
    card.addEventListener('mousemove', onMove);
    card.addEventListener('mouseleave', reset);
  });

  // ── Scroll cue ───────────────────────────────────────
  const cue = document.querySelector('.hero-scroll');
  if (cue) {
    cue.addEventListener('click', () => {
      const target = document.querySelector('.modules-section');
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    });
  }
})();
