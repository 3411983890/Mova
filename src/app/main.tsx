import { createRoot } from 'react-dom/client';
import '../../app.js';
import { WindowControls } from './window-controls';

const controls = document.querySelector('#window-controls');
if (controls) {
  const desktop = window.movaDesktop;
  if (desktop) {
    document.documentElement.classList.add('desktop-window');
    controls.setAttribute('aria-label', '窗口控制');
  }
  createRoot(controls).render(<WindowControls desktop={desktop} />);
}
