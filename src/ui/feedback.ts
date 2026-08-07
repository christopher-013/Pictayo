const FEEDBACK_ENDPOINT =
  'https://pictayo.cch13.workers.dev/api/feedback';

/**
 * How long to wait for the feedback service before giving up.
 *
 * Without this the request has no upper bound: a Worker that accepts the
 * connection and then stalls leaves the submit button disabled and the status
 * reading "Sending…" indefinitely, with no way to retry short of reloading.
 * Timing out routes the failure into the existing catch, which re-enables the
 * button and offers to try again.
 */
const SUBMIT_TIMEOUT_MS = 15_000;

type FeedbackResponse = {
  ok?: boolean;
  number?: number | null;
  error?: string;
};

/** Opens and submits the Pictayo feedback form without leaving the app. */
export function initFeedback(): void {
  const dialog = must<HTMLDialogElement>('feedback-dialog');
  const form = must<HTMLFormElement>('feedback-form');
  const close = must<HTMLButtonElement>('feedback-dialog-close');
  const cancel = must<HTMLButtonElement>('feedback-cancel');
  const status = must('feedback-status');
  const summary = must<HTMLInputElement>('feedback-summary');
  const message = must<HTMLTextAreaElement>('feedback-message');
  const website = must<HTMLInputElement>('feedback-website');
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');

  const closeDialog = (): void => dialog.close();
  close.addEventListener('click', closeDialog);
  cancel.addEventListener('click', closeDialog);
  dialog.addEventListener('close', () => {
    form.reset();
    status.textContent = '';
    status.className = 'feedback-status';
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog();
  });

  for (const opener of document.querySelectorAll<HTMLElement>('[data-open-feedback]')) {
    opener.addEventListener('click', () => {
      status.textContent = '';
      status.className = 'feedback-status';
      dialog.showModal();
      window.setTimeout(() => summary.focus(), 0);
    });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit?.disabled) return;
    void submitFeedback();
  });

  async function submitFeedback(): Promise<void> {
    const category =
      form.querySelector<HTMLInputElement>('input[name="feedback-category"]:checked')
        ?.value ?? 'other';

    status.textContent = 'Sending…';
    status.className = 'feedback-status';
    if (submit) submit.disabled = true;

    try {
      const response = await fetch(FEEDBACK_ENDPOINT, {
        method: 'POST',
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          summary: summary.value,
          message: message.value,
          website: website.value,
          page: `${location.pathname}${location.hash}`,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          version:
            document.querySelector<HTMLMetaElement>('meta[name="pictayo-version"]')
              ?.content ?? '',
          userAgent: navigator.userAgent,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as FeedbackResponse;
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || `Feedback request failed (${response.status})`);
      }

      // The issue number is deliberately not shown. It is a pointer into a
      // public tracker, and the person sending feedback has no use for it.
      status.textContent = 'Thank you — feedback was sent.';
      status.className = 'feedback-status is-success';
      form.reset();
      window.setTimeout(() => {
        if (dialog.open) dialog.close();
      }, 1800);
    } catch (error) {
      console.warn('Could not submit feedback', error);
      const detail = error instanceof Error ? error.message : '';
      const safeDetail =
        /^(Feedback contains|Please wait|A summary is required|Feedback is too long)/.test(detail)
          ? detail
          : '';
      status.textContent = safeDetail || 'Couldn’t send right now — check your connection and try again.';
      status.className = 'feedback-status is-error';
    } finally {
      if (submit) submit.disabled = false;
    }
  }
}

function must<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
