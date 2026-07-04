export function parsePriceValue(price) {
  if (typeof price === 'number') {
    return Number.isFinite(price) ? price : 0;
  }

  const cleaned = String(price || '')
    .trim()
    .replace(/\s/g, '')
    .replace(/[^\d.,-]/g, '');

  if (!cleaned) {
    return 0;
  }

  const commaIndex = cleaned.lastIndexOf(',');
  const dotIndex = cleaned.lastIndexOf('.');
  let normalized = cleaned;

  if (commaIndex > -1 && dotIndex > -1) {
    const decimalSeparator = commaIndex > dotIndex ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';

    normalized = cleaned
      .replace(new RegExp(`\\${thousandsSeparator}`, 'g'), '')
      .replace(decimalSeparator, '.');
  } else if (commaIndex > -1) {
    normalized = normalizeSingleSeparator(cleaned, ',');
  } else if (dotIndex > -1) {
    normalized = normalizeSingleSeparator(cleaned, '.');
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
}

export function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value || 0);
}

function normalizeSingleSeparator(value, separator) {
  const parts = value.split(separator);
  const lastPart = parts.at(-1) || '';

  if (parts.length === 2 && lastPart.length > 0 && lastPart.length <= 2) {
    return value.replace(separator, '.');
  }

  if (parts.length > 2 && lastPart.length > 0 && lastPart.length <= 2) {
    return `${parts.slice(0, -1).join('')}.${lastPart}`;
  }

  return parts.join('');
}
