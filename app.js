import { mountMugViewer } from './mug-viewer.js';

const viewerElement = document.querySelector('#mug-viewer');
const rail = document.querySelector('.angle-rail');
const viewer = mountMugViewer(viewerElement);

for (let index = 0; index < 18; index += 1) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'angle-tick';
  button.dataset.label = `View ${String(index + 1).padStart(2, '0')}`;
  button.setAttribute('aria-label', `Turn mug to view ${index + 1} of 18`);
  button.setAttribute('aria-pressed', String(index === 0));
  button.addEventListener('click', () => {
    for (const tick of rail.children) tick.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-pressed', 'true');
    viewer.setYaw(index * Math.PI * 2 / 18);
  });
  rail.append(button);
}

// The rail follows the real rendered turntable angle, including mouse and keyboard input.
const angleObserver = new MutationObserver(() => {
  const yaw = Number(viewerElement.dataset.yaw);
  if (!Number.isFinite(yaw)) return;
  const turn = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const selected = Math.round(turn / (Math.PI * 2) * 18) % 18;
  Array.from(rail.children).forEach((tick, index) => tick.setAttribute('aria-pressed', String(index === selected)));
});
angleObserver.observe(viewerElement, { attributes: true, attributeFilter: ['data-yaw'] });

for (const button of document.querySelectorAll('[data-open]')) {
  button.addEventListener('click', () => document.getElementById(button.dataset.open).showModal());
}
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
}

const photos = Array.from(document.querySelectorAll('[data-photo]'));
const photoDialog = document.querySelector('#photo-dialog');
let photoIndex = 0;
function showPhoto(index) {
  photoIndex = (index + photos.length) % photos.length;
  const card = photos[photoIndex];
  const source = card.querySelector('img');
  const large = document.querySelector('#large-photo');
  large.src = source.src;
  large.alt = source.alt;
  document.querySelector('#large-photo-window').classList.toggle('photo-window--17', photoIndex === 2);
  document.querySelector('#large-caption').textContent = card.querySelector('.photo-caption').firstChild.textContent.trim();
  document.querySelector('#photo-count').textContent = `0${photoIndex + 1} / 03`;
  photoDialog.setAttribute('aria-label', `Mug photograph ${photoIndex + 1} of 3`);
}
photos.forEach((card, index) => card.addEventListener('click', () => {
  showPhoto(index);
  photoDialog.showModal();
}));
document.querySelector('#previous-photo').addEventListener('click', () => showPhoto(photoIndex - 1));
document.querySelector('#next-photo').addEventListener('click', () => showPhoto(photoIndex + 1));
photoDialog.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    showPhoto(photoIndex + (event.key === 'ArrowLeft' ? -1 : 1));
  }
});
