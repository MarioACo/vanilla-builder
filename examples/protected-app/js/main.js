import { priceFor } from './pricing.js';
import { formatMoney } from './vendor/money-format.js';

const qty = document.getElementById('qty');
const total = document.getElementById('total');

function update() {
  total.textContent = formatMoney(priceFor(Number(qty.value)));
}

qty.addEventListener('input', update);
update();
