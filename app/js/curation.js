// Entry point for the curation page.
//
// The studio itself still lives in `modules/curation.js` — it was written as a
// full-screen overlay inside the editor, and the work of making it a page was
// in the frame (a masthead, a route, a stylesheet), not in the logic. This file
// is that frame: themes, colour mode, the localhost-only editor link, then hand
// over. Mirrors `archive.js`, which did the same job for the archive.
import { loadThemes, applyThemeClass, getCurrentThemeId } from './modules/theme.js';
import { initThemePicker } from './modules/themePicker.js';
import { initAppMenu } from './modules/appMenu.js';
import { isLocalhost } from './modules/utils.js';
import { openCurationStudio } from './modules/curation.js';

async function init() {
  await loadThemes().catch(() => {});
  applyThemeClass(getCurrentThemeId());
  initThemePicker();
  initAppMenu({ adopt: ['.app-nav'] });

  // The editor is a local tool, so it is offered only where it can run.
  if (isLocalhost()) document.getElementById('curationEditorLink')?.classList.remove('hidden');

  openCurationStudio();
}

// Revealed in a `finally` for the same reason the editor is: the page starts at
// `opacity: 0`, so a throw during start-up would otherwise leave it blank with
// nothing to report.
void init()
  .catch((err) => console.error('[curation init]', err))
  .finally(() => {
    document.documentElement.style.opacity = '1';
  });
