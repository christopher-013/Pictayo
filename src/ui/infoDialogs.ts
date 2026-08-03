/** Wires the static Privacy and Learn More cards as accessible native dialogs. */
export function initInfoDialogs(): void {
  const dialogs = new Map<string, HTMLDialogElement>();
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('.info-dialog')) {
    dialogs.set(dialog.id.replace(/-dialog$/, ''), dialog);

    dialog.querySelector<HTMLElement>('[data-close-info]')?.addEventListener('click', () => {
      dialog.close();
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  for (const opener of document.querySelectorAll<HTMLElement>('[data-open-info]')) {
    opener.addEventListener('click', () => {
      const name = opener.dataset.openInfo;
      const dialog = name ? dialogs.get(name) : undefined;
      if (!dialog) return;

      // A dialog cannot be opened above another modal. Close the current info
      // card first when Privacy is opened from inside Learn More.
      for (const candidate of dialogs.values()) {
        if (candidate !== dialog && candidate.open) candidate.close();
      }
      dialog.showModal();
      window.setTimeout(() => dialog.querySelector<HTMLElement>('[data-close-info]')?.focus(), 0);
    });
  }
}
