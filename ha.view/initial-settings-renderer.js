'use strict';
const form = document.querySelector('form');
const input = document.querySelector('#url');
const status = document.querySelector('#status');
form.addEventListener('submit', async event => {
  event.preventDefault();
  status.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try { await window.initialSettings.save(input.value); }
  catch (error) { status.textContent = error.message; button.disabled = false; }
});
