export interface ConfirmDialogOptions {
  eyebrow: string;
  title: string;
  message: string;
  note: string;
  confirmLabel: string;
  icon?: string;
}

let dialog: HTMLDialogElement;
let eyebrow: HTMLElement;
let title: HTMLElement;
let message: HTMLElement;
let note: HTMLElement;
let icon: HTMLElement;
let confirmButton: HTMLButtonElement;

export function initConfirmDialog(): void {
  dialog = must<HTMLDialogElement>('action-dialog');
  eyebrow = must('action-dialog-eyebrow');
  title = must('action-dialog-title');
  message = must('action-dialog-message');
  note = must('action-dialog-note');
  icon = must('action-dialog-icon');
  confirmButton = must<HTMLButtonElement>('action-dialog-confirm');

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dialog.close('cancel');
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close('cancel');
  });
}

export function confirmAction(options: ConfirmDialogOptions): Promise<boolean> {
  eyebrow.textContent = options.eyebrow;
  title.textContent = options.title;
  message.textContent = options.message;
  note.textContent = options.note;
  icon.textContent = options.icon ?? '🗑';
  confirmButton.textContent = options.confirmLabel;

  return new Promise((resolve) => {
    const onClose = () => resolve(dialog.returnValue === 'confirm');
    dialog.addEventListener('close', onClose, { once: true });
    dialog.showModal();
  });
}

function must<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
