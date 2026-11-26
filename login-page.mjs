export function loginPage(scope) {
  const reviewer = scope === 'reviewer';
  const mainTitle = reviewer ? 'Reviewer sign-in' : 'Sign in to Foundation Week';
  const instructions = reviewer ? 'Enter your approved reviewer email address.' : 'Enter your @bvclogistics.com work email.';
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BVC Logistics | ${mainTitle}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#080f6b;color:#11143d;font:1rem/1.55 system-ui,sans-serif}
main{width:min(31rem,calc(100% - 2rem));margin:clamp(2rem,9vh,6rem) auto;padding:clamp(1.25rem,5vw,2.35rem);background:white;border-radius:1.15rem}
h1{font-size:clamp(1.8rem,6vw,2.45rem);line-height:1.08;margin:.4rem 0 .75rem}
.brand{color:#080f6b;font-size:.9rem;font-weight:750;margin:0;padding-bottom:.3rem}
label{font-weight:700;display:block;margin-bottom:.3rem}input,button{font:inherit}
input{width:100%;border:1px solid #8a93b9;border-radius:.45rem;padding:.65rem .8rem}
button{background:#ffce00;color:#080f6b;border:0;border-radius:99px;font-weight:750;padding:.65rem 1rem;margin:1rem 0 0;cursor:pointer}
:focus-visible{outline:3px solid #5164db;outline-offset:3px}.secondary{background:#eef0ff}
.error{color:#a01b22;font-weight:650}.hidden,[hidden]{display:none!important}
</style>
<main>
<p class="brand">BVC Logistics · Foundation Week</p>
<h1>${mainTitle}</h1>
<form id="email-form">
<p>${instructions} We’ll send a six-digit code to your inbox.</p>
<label for="email">Email address</label>
<input id="email" type="email" autocomplete="email" maxlength="254" required>
<button type="submit">Send sign-in code</button>
</form>
<form id="code-form" hidden>
<p id="instructions">If the address is eligible, a code will arrive by email. Check your junk folder if you don’t see it.</p>
<label for="code">Six-digit sign-in code</label>
<input id="code" type="text" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" required>
<button type="submit">Sign in</button>
<button class="secondary" id="back" type="button">Request another code</button>
</form>
<p class="error" id="error" role="alert" hidden></p>
</main>
<script>
const emailForm = document.querySelector('#email-form');
const codeForm = document.querySelector('#code-form');
const email = document.querySelector('#email');
const code = document.querySelector('#code');
const error = document.querySelector('#error');
let loading = false;
async function submit(path, data, form, success) {
  if (loading) return;
  loading = true;
  error.hidden = true;
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const response = await fetch('/auth/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Please try again.');
    success();
  } catch (failure) {
    error.textContent = failure instanceof SyntaxError || failure instanceof TypeError
      ? 'Couldn’t reach the sign-in service. Please try again.' : failure.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
    loading = false;
  }
}
emailForm.addEventListener('submit', event => {
  event.preventDefault();
  submit('send', { email: email.value }, emailForm, () => {
    emailForm.hidden = true;
    codeForm.hidden = false;
    code.focus();
  });
});
codeForm.addEventListener('submit', event => {
  event.preventDefault();
  submit('verify', { code: code.value.trim() }, codeForm, () => location.replace('/'));
});
document.querySelector('#back').addEventListener('click', () => {
  if (loading) return;
  code.value = '';
  error.hidden = true;
  codeForm.hidden = true;
  emailForm.hidden = false;
  email.focus();
});
</script></html>`;
}
