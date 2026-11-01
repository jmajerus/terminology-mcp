// Who is looking: visitors get a read-only page, linking to the same page on the editing hostname when there is one.
export const viewer = await fetch('/api/viewer').then(response => response.ok ? response.json() : { canEdit: false })
  .catch(() => ({ canEdit: false }));

document.documentElement.classList.toggle('read-only', !viewer.canEdit);
const bar = document.querySelector('.topbar');
if (bar && (!viewer.canEdit || viewer.signOut)) {
  const who = document.createElement('span');
  who.className = 'viewer';
  if (!viewer.canEdit) {
    who.innerHTML = '<span class="badge">Read-only</span>';
    if (viewer.edit) {
      const link = document.createElement('a');
      link.className = 'button small'; link.textContent = 'Sign in to edit';
      // Opens the page being viewed, including the selected term, on the editing hostname.
      const target = () => { link.href = viewer.edit + location.pathname + location.search + location.hash; };
      target(); link.addEventListener('click', target);
      who.append(link);
    }
  } else {
    who.textContent = viewer.name ?? 'Signed in';
    who.insertAdjacentHTML('beforeend', `<a class="text-button" href="${viewer.signOut}">Sign out</a>`);
  }
  // Takes the place of the local-workspace label, before the changelog number.
  const local = bar.querySelector('.local-label');
  if (local) local.replaceWith(who); else bar.insertBefore(who, bar.querySelector('.version'));
}

/** Makes a form's fields read-only for visitors; buttons that only navigate stay usable. */
export function lockForm(form) {
  if (viewer.canEdit || !form) return;
  for (const field of form.querySelectorAll('input, textarea')) {
    if (['checkbox', 'radio', 'file'].includes(field.type)) field.disabled = true; else field.readOnly = true;
  }
  for (const field of form.querySelectorAll('select')) field.disabled = true;
  for (const button of form.querySelectorAll('button:not([data-pick]):not([data-focus])')) button.disabled = true;
}

// Controls marked data-write stay in place, greyed out, including ones rendered or re-enabled later.
const WRITE_CONTROLS = '[data-write]:is(button, input, select, textarea), [data-write] :is(button, input, select, textarea)';
function greyOut(root) {
  if (!(root instanceof Element)) return;
  for (const control of [...(root.matches(WRITE_CONTROLS) ? [root] : []), ...root.querySelectorAll(WRITE_CONTROLS)]) {
    if (!control.disabled) control.disabled = true;
    control.title = 'Sign in to edit';
  }
  for (const link of [...(root.matches('a[data-write]') ? [root] : []), ...root.querySelectorAll('a[data-write]')]) {
    link.setAttribute('aria-disabled', 'true'); link.tabIndex = -1; link.title = 'Sign in to edit';
  }
}
if (!viewer.canEdit) {
  greyOut(document.body);
  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') greyOut(mutation.target);
      else for (const added of mutation.addedNodes) greyOut(added);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
}
