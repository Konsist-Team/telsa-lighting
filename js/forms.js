/**
 * Form submission for the contact, lead-generation and newsletter forms.
 *
 * The Webflow export ships webflow's own form handler, which posts to
 * webflow.com and only works on Webflow hosting. It is bound as a delegated
 * listener on `document`, so stopping propagation here on the form itself keeps
 * it from ever running.
 *
 * Two endpoints, two response shapes:
 *   /api/contact                    same-origin Worker  -> { ok, error }
 *   konsist-api …/newsletter/subscribe  cross-origin    -> { success, message }
 * Both are normalised below so the forms behave identically.
 */
(function () {
  'use strict';

  var CONTACT_ENDPOINT = '/api/contact';

  var forms = document.querySelectorAll(
    'form[data-form="contact"], form[data-form="lead"], form[data-form="subscription"]'
  );

  Array.prototype.forEach.call(forms, function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      event.stopPropagation();
      submit(form);
    });
  });

  function submit(form) {
    var kind = form.dataset.form;
    var isSubscription = kind === 'subscription';
    // Newsletter forms carry their own absolute action; the site's own forms
    // post back to this origin.
    var endpoint = form.getAttribute('action') || CONTACT_ENDPOINT;

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

    var data = new FormData(form);
    // data-form is an attribute, so FormData does not pick it up. The contact
    // Worker needs it to choose the required-field set and subject line.
    if (!isSubscription) data.append('form', kind);

    fetch(endpoint, { method: 'POST', body: data })
      .then(function (response) {
        return response.json().catch(function () {
          return {};
        });
      })
      .then(function (result) {
        // { ok, error } from the contact Worker, { success, message } from the
        // newsletter endpoint.
        var succeeded = result.ok === true || result.success === true;
        var message = result.error || result.message;

        if (succeeded) {
          form.reset();
          form.style.display = 'none';
          hide(failBlock);
          if (isSubscription) {
            setText(doneBlock, 'Got it! Keep an eye out for our emails.');
            remember();
          }
          show(doneBlock);
        } else {
          fail(failBlock, message);
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
        var widget = form.querySelector('.cf-turnstile');
        if (widget && window.turnstile) window.turnstile.reset(widget);
      });
  }

  function remember() {
    // Preserved from the markup this replaces. Wrapped because Safari's private
    // mode throws on write.
    try {
      localStorage.subscribed = 'true';
    } catch (e) {}
  }

  function fail(failBlock, message) {
    setText(failBlock, message);
    show(failBlock);
  }

  function setText(block, message) {
    if (!block || !message) return;
    var target = block.querySelector('div') || block;
    target.textContent = message;
  }

  function show(el) {
    if (el) el.style.display = 'block';
  }

  function hide(el) {
    if (el) el.style.display = 'none';
  }
})();
