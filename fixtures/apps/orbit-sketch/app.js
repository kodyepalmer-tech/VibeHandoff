const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
function resize() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;
}
resize();
addEventListener('resize', resize);
let drawing = false;
canvas.addEventListener('pointerdown', () => { drawing = true; });
canvas.addEventListener('pointerup', () => { drawing = false; });
canvas.addEventListener('pointermove', (event) => {
  if (!drawing) return;
  ctx.fillStyle = '#d96b2b';
  ctx.beginPath();
  ctx.arc(event.clientX, event.clientY, 4, 0, Math.PI * 2);
  ctx.fill();
});
