// Who is looking: visitors who aren't signed in get a read-only page and a sign-in link.
export const viewer = await fetch('/api/viewer').then(response => response.ok ? response.json() : { canEdit: false })
  .catch(() => ({ canEdit: false }));

document.documentElement.classList.toggle('read-only', !viewer.canEdit);
const bar = document.querySelector('.topbar');
if (bar && (!viewer.canEdit || viewer.signOut)) {
  const who = document.createElement('span');
  who.className = 'viewer';
  if (!viewer.canEdit) {
    who.innerHTML = `<span class="badge">Read-only</span><a class="button small" href="${viewer.signIn ?? '/sign-in'}">Sign in to edit</a>`;
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
