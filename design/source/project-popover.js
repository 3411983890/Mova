(() => {
  const dialog = document.querySelector('#project-dialog');
  const trigger = document.querySelector('#new-project');
  const form = document.querySelector('#project-form');
  const name = document.querySelector('#project-name');
  const create = form.querySelector('.create-project');
  const folder = document.querySelector('#project-folder');
  const folderList = document.querySelector('#project-folder-list');
  const addFolder = document.querySelector('#project-folder-add');
  const addMore = document.querySelector('#project-folder-more');
  const status = document.querySelector('#project-form-status');
  let sourceFolders = [];
  let picking = false;
  let generation = 0;
  const memoryToggle = document.querySelector('#project-memory-toggle');
  const memoryMenu = document.querySelector('#project-memory-menu');
  const deviceToggle = document.querySelector('#project-device-toggle');
  const deviceMenu = document.querySelector('#project-device-menu');
  const remoteStatus = document.querySelector('#project-remote-status');

  function closeMenu(toggle, menu) {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }
  function closeMenus() {
    closeMenu(memoryToggle, memoryMenu);
    closeMenu(deviceToggle, deviceMenu);
  }
  function placeMemoryMenu() {
    memoryMenu.classList.remove('menu-above');
    if (memoryMenu.getBoundingClientRect().bottom > window.innerHeight - 12) memoryMenu.classList.add('menu-above');
  }
  function toggleMenu(toggle, menu) {
    const opening = menu.hidden;
    closeMenus();
    if (!opening) return;
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    if (menu === memoryMenu) placeMemoryMenu();
  }
  function updateCreate() {
    name.required = dialog.classList.contains('is-editing') || !sourceFolders.length;
    create.disabled = picking || (!name.value.trim() && !sourceFolders.length);
  }
  function renderFolders() {
    form.dataset.sourceFolders = JSON.stringify(sourceFolders);
    dialog.classList.toggle('has-source-folders', sourceFolders.length > 0);
    folderList.hidden = addMore.hidden = sourceFolders.length === 0;
    folderList.replaceChildren();
    for (const [index, source] of sourceFolders.entries()) {
      const row = document.createElement('div');
      row.className = 'project-folder-row';
      row.append(document.querySelector('.project-name-field > i').cloneNode(true));
      const label = document.createElement('span');
      label.textContent = source.name;
      label.title = source.path || source.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除文件夹：${source.name}`);
      remove.append(document.querySelector('#close-project i').cloneNode(true));
      remove.addEventListener('click', () => { sourceFolders.splice(index, 1); name.setCustomValidity(''); renderFolders(); });
      row.append(label, remove);
      folderList.append(row);
    }
    updateCreate();
  }
  function appendFolders(folders) {
    for (const item of folders) {
      const key = (item.path || `browser:${item.name}`).toLocaleLowerCase();
      if (!sourceFolders.some(source => (source.path || `browser:${source.name}`).toLocaleLowerCase() === key)) sourceFolders.push(item);
    }
    name.setCustomValidity('');
    renderFolders();
  }
  function resetFolder() {
    generation += 1;
    picking = false;
    addFolder.disabled = addMore.disabled = false;
    sourceFolders = [];
    folder.value = '';
    status.hidden = true;
    renderFolders();
  }
  async function pickFolders() {
    closeMenus();
    if (picking) return;
    const desktop = window.movaDesktop?.projects;
    if (!desktop?.pickFolders) { folder.click(); return; }
    const requestGeneration = generation;
    picking = true;
    addFolder.disabled = addMore.disabled = true;
    status.hidden = true;
    updateCreate();
    try {
      const selected = await desktop.pickFolders();
      if (requestGeneration !== generation || !dialog.open) return;
      appendFolders(selected);
    } catch (error) {
      if (requestGeneration === generation && dialog.open) {
        status.textContent = `无法选择文件夹：${error.message || '请重试'}`;
        status.hidden = false;
      }
    } finally {
      if (requestGeneration === generation) {
        picking = false;
        addFolder.disabled = addMore.disabled = false;
        updateCreate();
      }
    }
  }
  function resetOptions() {
    closeMenus();
    resetFolder();
    remoteStatus.hidden = true;
    document.querySelector('#project-memory-label').textContent = '默认记忆';
    memoryMenu.querySelectorAll('[data-memory]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.memory === 'default')));
  }

  new MutationObserver(() => {
    trigger.setAttribute('aria-expanded', String(dialog.open));
    if (dialog.open) {
      const title = document.querySelector('#project-dialog-title');
      const editing = title.textContent.trim() === '编辑项目';
      dialog.classList.toggle('is-editing', editing);
      if (!editing) title.textContent = '创建项目';
      create.textContent = editing ? '保存' : '创建项目';
      updateCreate();
    } else resetOptions();
  }).observe(dialog, { attributes: true, attributeFilter: ['open'] });

  form.addEventListener('reset', resetOptions);
  name.addEventListener('input', updateCreate);
  document.querySelector('#close-project').addEventListener('click', () => dialog.close());
  let backdropPointer = false;
  dialog.addEventListener('pointerdown', event => {
    const r = dialog.getBoundingClientRect();
    backdropPointer = event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  });
  dialog.addEventListener('click', event => {
    const r = dialog.getBoundingClientRect();
    const outside = event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
    // Dropdowns may extend beyond the dialog's rectangle; they are not backdrop clicks.
    if (backdropPointer && outside && event.target === dialog) dialog.close();
    backdropPointer = false;
    if (!event.target.closest('.project-memory-wrap, .project-device-wrap')) closeMenus();
  });
  for (const button of [addFolder, addMore]) button.addEventListener('click', pickFolders);
  folder.addEventListener('change', () => {
    const first = folder.files && folder.files[0];
    if (!first) return;
    const parent = first.webkitRelativePath.split('/')[0] || first.name;
    appendFolders([{ id: `browser-${parent}`, name: parent, path: null }]);
    folder.value = '';
  });
  deviceToggle.addEventListener('click', () => toggleMenu(deviceToggle, deviceMenu));
  document.querySelector('#project-device-local').addEventListener('click', () => { closeMenus(); deviceToggle.focus(); });
  document.querySelector('#project-add-remote').addEventListener('click', () => { remoteStatus.hidden = false; });
  memoryToggle.addEventListener('click', () => toggleMenu(memoryToggle, memoryMenu));
  memoryMenu.addEventListener('click', event => {
    const option = event.target.closest('[data-memory]');
    if (!option) return;
    memoryMenu.querySelectorAll('[data-memory]').forEach(button => button.setAttribute('aria-pressed', String(button === option)));
    document.querySelector('#project-memory-label').textContent = option.querySelector('strong').textContent;
    closeMenus();
    memoryToggle.focus();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && (!memoryMenu.hidden || !deviceMenu.hidden)) {
      event.preventDefault();
      event.stopPropagation();
      const toggle = memoryMenu.hidden ? deviceToggle : memoryToggle;
      closeMenus();
      toggle.focus();
    }
    if (event.key === 'ArrowDown' && (event.target === deviceToggle || event.target === memoryToggle)) {
      event.preventDefault();
      const menu = event.target === deviceToggle ? deviceMenu : memoryMenu;
      if (menu.hidden) toggleMenu(event.target, menu);
      menu.querySelector('button').focus();
    }
  });
  window.addEventListener('resize', () => { if (!memoryMenu.hidden) placeMemoryMenu(); });
})();
