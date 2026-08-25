/**
 * Submits the contact and lead-generation forms to /api/contact.
 *
 * The Webflow export still ships webflow's own form handler, which posts to
 * webflow.com and only works on Webflow hosting. That handler is bound as a
 * delegated listener on `document`, so stopping propagation here on the form
 * itself keeps it from ever running.
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/contact';

  document.querySelectorAll('form[data-form="contact"], form[data-form="lead"]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      event.stopPropagation();
      submit(form);
    });
  });

  function submit(form) {
    var container = form.closest('.w-form') || form.parentNode;
    var doneBlock = container.querySelector('.w-form-done');
    var failBlock = container.querySelector('.w-form-fail');
    var button = form.querySelector('[type="submit"]');
    var idleLabel = button ? button.value : '';

    if (button) {
      button.disabled = true;
      button.value = button.getAttribute('data-wait') || 'Please wait...';
    }
    hide(failBlock);

    // data-form is an attribute, so FormData does not pick it up. The handler
    // needs it to choose the required-field set and the subject line.
    var data = new FormData(form);
    data.append('form', form.dataset.form);

    fetch(ENDPOINT, { method: 'POST', body: data })
      .then(function (response) {
        return response.json().catch(function () {
          return { ok: false };
        });
      })
      .then(function (result) {
        if (result.ok) {
          form.reset();
          form.style.display = 'none';
          hide(failBlock);
          show(doneBlock);
        } else {
          fail(failBlock, result.error);
        }
      })
      .catch(function () {
        fail(failBlock, 'We could not reach the server. Please check your connection and try again.');
      })
      .then(function () {
        if (button) {
          button.disabled = false;
          button.value = idleLabel;
        }
        // Turnstile tokens are single use, so a retry needs a fresh one.
        if (window.turnstile) {
          window.turnstile.reset(form.querySelector('.cf-turnstile'));
        }
      });
  }

  function fail(failBlock, message) {
    if (!failBlock) return;
    var target = failBlock.querySelector('div') || failBlock;
    if (message) target.textContent = message;
    show(failBlock);
  }

  function show(el) {
    if (el) el.style.display = 'block';
  }

  function hide(el) {
    if (el) el.style.display = 'none';
  }
})();
