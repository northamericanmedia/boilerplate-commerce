/**
 * Cart Shipments Module
 * Groups cart items by source/warehouse and displays them as separate shipments
 * with delivery options for each shipment.
 *
 * This module integrates with the Multi-Source Inventory (MSI) shipping system
 * that returns composite shipping rates with per-source delivery options.
 */

import { events } from '@dropins/tools/event-bus.js';

// ============================================================================
// Constants
// ============================================================================

// Storage keys (matching dropin conventions)
const STORAGE_KEY_SHIPPING_DATA = 'DROPIN__CART__SHIPPING__DATA';
const STORAGE_KEY_AUTH = 'DROPIN__CART__CART__AUTHENTICATED';

// Carrier/method identifiers
const CARRIER_COMPOSITE = 'composite';

// Data keys
const KEY_SOURCE_RATES = 'source_rates';
const KEY_EXT_SHIPPING_INFO = 'ext_shipping_info';

// CSS classes
const CLASS_SHIPMENTS_CONTAINER = 'shipments-container';
const CLASS_SHIPMENT_CONTAINER = 'shipment-container';
const CLASS_SHIPMENT_HEADER = 'shipment-header';
const CLASS_SHIPMENT_HEADER_TITLE = 'shipment-header__title';
const CLASS_SHIPMENT_HEADER_SUBTITLE = 'shipment-header__subtitle';
const CLASS_SHIPMENT_CONTENT = 'shipment-content';
const CLASS_SHIPMENT_ITEMS = 'shipment-items';
const CLASS_SHIPMENT_ITEMS_HEADER = 'shipment-items__header';
const CLASS_SHIPMENT_ITEMS_HEADER_CELL = 'shipment-items__header-cell';
const CLASS_SHIPMENT_ITEMS_LIST = 'shipment-items__list';
const CLASS_SHIPMENT_ITEM_WRAPPER = 'shipment-item-wrapper';
const CLASS_SHIPMENT_ITEM_SPLIT_NOTE = 'shipment-item-split-note';
const CLASS_DELIVERY_OPTIONS = 'shipment-delivery-options';
const CLASS_DELIVERY_OPTIONS_HEADING = 'shipment-delivery-options__heading';
const CLASS_DELIVERY_OPTIONS_CONTENT = 'shipment-delivery-options__content';
const CLASS_DELIVERY_OPTIONS_LABEL = 'shipment-delivery-options__label';
const CLASS_DELIVERY_OPTIONS_FORM = 'shipment-delivery-options__form';
const CLASS_DELIVERY_OPTION = 'shipment-delivery-option';
const CLASS_DELIVERY_OPTION_LABEL = 'shipment-delivery-option__label';
const CLASS_DELIVERY_OPTION_METHOD = 'shipment-delivery-option__method';
const CLASS_DELIVERY_OPTION_PRICE = 'shipment-delivery-option__price';
const CLASS_ORDER_SUMMARY = 'cart-order-summary';
const CLASS_ORDER_SUMMARY_LOADING = 'cart-order-summary--loading';
const CLASS_CART_SUMMARY_LIST = 'cart-cart-summary-list';
const CLASS_CART_SUMMARY_HEADING = 'cart-cart-summary-list__heading';
const CLASS_CART_SUMMARY_CONTENT = 'cart-cart-summary-list__content';

// Dropin selectors
const SELECTOR_CART_ITEM_QUANTITY = '.dropin-cart-item__quantity';
const SELECTOR_CART_ITEM_REMOVE = '.dropin-cart-item__remove';
const SELECTOR_QUANTITY_INPUT = 'input[name="quantity"]';
const SELECTOR_RADIO_CHECKED = 'input[type="radio"]:checked';
const SELECTOR_RADIO = 'input[type="radio"]';
const SELECTOR_ESTIMATE_COUNTRY = '[data-testid="estimate-shipping-country-selector"]';
const SELECTOR_ESTIMATE_STATE_INPUT = '[data-testid="estimate-shipping-state-input"]';
const SELECTOR_ESTIMATE_STATE_SELECT = '[data-testid="estimate-shipping-state-selector"]';
const SELECTOR_ESTIMATE_ZIP = '[data-testid="estimate-shipping-zip-input"]';
const SELECTOR_ESTIMATE_APPLY = '[data-testid="estimate-shipping-apply-button"]';
const SELECTOR_SHIPPING_PRICE = '.cart-estimate-shipping__price';
const SELECTOR_CART_LIST = '[data-testid="cart-list"]';

// Defaults
const DEFAULT_COUNTRY = 'US';
const DEFAULT_CURRENCY = 'USD';
const DEFAULT_LOCALE = 'en-US';

// Timing constants (only for user input debouncing and geolocation API)
const DEBOUNCE_DELAY_MS = 300;
const GEOLOCATION_TIMEOUT_MS = 10000;
const GEOLOCATION_MAX_AGE_MS = 300000;

// Table headers
const TABLE_HEADERS = ['Item', 'Price', 'Qty', 'Subtotal'];

// Text constants
const TEXT_DELIVERY_OPTIONS = 'Delivery Options';
const TEXT_CHOOSE_DELIVERY = 'Choose your delivery option:';
const TEXT_UNKNOWN_LOCATION = 'Unknown Location';
const TEXT_STANDARD_SHIPPING = 'Standard Shipping';

// Google Geocoding API
const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

// ============================================================================
// Module State
// ============================================================================

let currentCartData = null;
let currentShippingData = null;
let cartListElement = null;
let shippingPersistenceInitialized = false;
let googleApiKey = null;

/**
 * Load Google API key from config
 * @returns {Promise<string|null>} API key or null
 */
async function loadGoogleApiKey() {
  if (googleApiKey) return googleApiKey;

  try {
    const response = await fetch('/config.json');
    const config = await response.json();
    googleApiKey = config?.public?.default?.['google-api-key'] || null;
    return googleApiKey;
  } catch (e) {
    return null;
  }
}

/**
 * Decode base64 cart item UID to get quote item ID
 * @param {string} uid - Base64 encoded UID
 * @returns {string} Decoded quote item ID
 */
function decodeCartItemUid(uid) {
  try {
    return atob(uid);
  } catch (e) {
    return uid;
  }
}

/**
 * Check if shipping response indicates composite/multi-source shipping
 * @param {Array} shippingMethods - Array of shipping methods from estimate
 * @returns {Object|null} The composite method with parsed source_rates, or null
 */
function getCompositeShippingData(shippingMethods) {
  if (!shippingMethods || !Array.isArray(shippingMethods)) {
    return null;
  }

  const compositeMethod = shippingMethods.find(
    (method) => method.carrier_code === CARRIER_COMPOSITE
      && method.method_code === CARRIER_COMPOSITE,
  );

  if (!compositeMethod?.additional_data) {
    return null;
  }

  const sourceRatesData = compositeMethod.additional_data.find(
    (data) => data.key === KEY_SOURCE_RATES,
  );

  if (!sourceRatesData?.value) {
    return null;
  }

  try {
    const sourceRates = JSON.parse(sourceRatesData.value);
    if (Object.keys(sourceRates).length < 2) {
      return null;
    }
    return { method: compositeMethod, sourceRates };
  } catch (e) {
    return null;
  }
}

/**
 * Group cart items by source based on shipping estimate response
 * @param {Array} cartItems - Cart items from cart data
 * @param {Object} sourceRates - Parsed source_rates from shipping estimate
 * @returns {Map} Map of sourceCode -> { source, rates, items }
 */
function groupItemsBySourceRates(cartItems, sourceRates) {
  const shipments = new Map();
  const itemIdToCartItem = new Map();

  cartItems.forEach((item) => {
    itemIdToCartItem.set(decodeCartItemUid(item.uid), item);
  });

  Object.entries(sourceRates).forEach(([sourceCode, sourceData]) => {
    const { source, rates, items } = sourceData;
    const shipmentItems = [];

    Object.entries(items).forEach(([quoteItemId, qty]) => {
      const cartItem = itemIdToCartItem.get(quoteItemId);
      if (cartItem) {
        shipmentItems.push({
          cartItem,
          sourceQty: qty,
          originalQty: cartItem.quantity,
        });
      }
    });

    shipments.set(sourceCode, { source, rates, items: shipmentItems });
  });

  return shipments;
}

/**
 * Format price for display
 * @param {number} price - Price value
 * @param {string} currency - Currency code
 * @returns {string} Formatted price
 */
function formatPrice(price, currency = DEFAULT_CURRENCY) {
  return new Intl.NumberFormat(DEFAULT_LOCALE, {
    style: 'currency',
    currency,
  }).format(price);
}

/**
 * Get source display name (city, region)
 * @param {Object} source - Source object from shipping response
 * @returns {string} Display name
 */
function getSourceDisplayName(source) {
  if (!source) return TEXT_UNKNOWN_LOCATION;
  const parts = [source.city, source.region].filter(Boolean);
  return parts.join(', ') || source.name || TEXT_UNKNOWN_LOCATION;
}

/**
 * Create delivery options HTML for a source
 * @param {string} sourceCode - Source code
 * @param {Object} rates - Rates object containing carrier arrays
 * @param {number} shipmentIndex - Shipment index for unique IDs
 * @returns {HTMLElement} Delivery options element
 */
function createDeliveryOptionsElement(sourceCode, rates, shipmentIndex) {
  const container = document.createElement('div');
  container.className = CLASS_DELIVERY_OPTIONS;

  const heading = document.createElement('div');
  heading.className = CLASS_DELIVERY_OPTIONS_HEADING;
  heading.textContent = TEXT_DELIVERY_OPTIONS;
  container.appendChild(heading);

  const content = document.createElement('div');
  content.className = CLASS_DELIVERY_OPTIONS_CONTENT;

  const label = document.createElement('div');
  label.className = CLASS_DELIVERY_OPTIONS_LABEL;
  label.textContent = TEXT_CHOOSE_DELIVERY;
  content.appendChild(label);

  const form = document.createElement('form');
  form.className = CLASS_DELIVERY_OPTIONS_FORM;
  form.dataset.sourceCode = sourceCode;

  let optionIndex = 0;
  let hasSelectedOption = false;

  Object.entries(rates).forEach(([, carrierRates]) => {
    carrierRates.forEach((rate) => {
      const optionEl = document.createElement('div');
      optionEl.className = CLASS_DELIVERY_OPTION;

      const radioId = `delivery-${shipmentIndex}-${optionIndex}`;

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `shipping_method_${sourceCode}`;
      radio.id = radioId;
      radio.value = rate.code;
      radio.dataset.sourceCode = sourceCode;
      radio.dataset.carrierCode = rate.carrier;
      radio.dataset.methodCode = rate.method;
      radio.dataset.price = rate.price;

      if (rate.selected) {
        radio.checked = true;
        hasSelectedOption = true;
      }

      radio.addEventListener('change', handleDeliveryOptionChange);

      const labelEl = document.createElement('label');
      labelEl.htmlFor = radioId;
      labelEl.className = CLASS_DELIVERY_OPTION_LABEL;

      const methodSpan = document.createElement('span');
      methodSpan.className = CLASS_DELIVERY_OPTION_METHOD;
      methodSpan.textContent = rate.method_title || rate.carrier_title || TEXT_STANDARD_SHIPPING;

      const priceSpan = document.createElement('span');
      priceSpan.className = CLASS_DELIVERY_OPTION_PRICE;
      priceSpan.textContent = formatPrice(rate.price);

      labelEl.appendChild(methodSpan);
      labelEl.appendChild(priceSpan);
      optionEl.appendChild(radio);
      optionEl.appendChild(labelEl);
      form.appendChild(optionEl);

      optionIndex += 1;
    });
  });

  if (!hasSelectedOption) {
    const firstRadio = form.querySelector(SELECTOR_RADIO);
    if (firstRadio) firstRadio.checked = true;
  }

  content.appendChild(form);
  container.appendChild(content);
  return container;
}

/**
 * Handle delivery option change
 */
async function handleDeliveryOptionChange() {
  // Show loading state immediately when user selects an option
  setOrderSummaryLoading(true);

  try {
    const sourceSelections = collectSourceSelections();
    const extShippingInfo = buildExtShippingInfo(sourceSelections);
    await updateShippingSelections(extShippingInfo);
  } catch (error) {
    // Silent fail - updateShippingSelections handles its own errors
  } finally {
    setOrderSummaryLoading(false);
  }
}

/**
 * Collect all selected shipping methods across all sources
 * @returns {Object} Map of sourceCode -> selected method info
 */
function collectSourceSelections() {
  const selections = {};
  const forms = document.querySelectorAll(`.${CLASS_DELIVERY_OPTIONS_FORM}`);

  forms.forEach((form) => {
    const { sourceCode } = form.dataset;
    const selectedRadio = form.querySelector(SELECTOR_RADIO_CHECKED);

    if (selectedRadio) {
      selections[sourceCode] = {
        selected: selectedRadio.value,
        carrierCode: selectedRadio.dataset.carrierCode,
        methodCode: selectedRadio.dataset.methodCode,
        price: parseFloat(selectedRadio.dataset.price) || 0,
      };
    }
  });

  return selections;
}

/**
 * Build ext_shipping_info JSON for the mutation
 * @param {Object} sourceSelections - Selected methods per source
 * @returns {string} JSON string for ext_shipping_info
 */
function buildExtShippingInfo(sourceSelections) {
  const extShippingInfo = {};

  Object.entries(sourceSelections).forEach(([sourceCode, selection]) => {
    const sourceData = currentShippingData?.sourceRates?.[sourceCode];
    const items = {};

    if (sourceData?.items) {
      Object.entries(sourceData.items).forEach(([quoteItemId, qty]) => {
        const cartItem = currentCartData?.items?.find(
          (item) => decodeCartItemUid(item.uid) === quoteItemId,
        );
        if (cartItem) {
          items[cartItem.sku] = qty;
        }
      });
    }

    let carrierTitle = TEXT_CHOOSE_DELIVERY;
    let methodTitle = '';
    if (sourceData?.rates) {
      Object.values(sourceData.rates).forEach((carrierRates) => {
        const selectedRate = carrierRates.find((r) => r.code === selection.selected);
        if (selectedRate) {
          carrierTitle = selectedRate.carrier_title || carrierTitle;
          methodTitle = selectedRate.method_title || '';
        }
      });
    }

    extShippingInfo[sourceCode] = {
      selected: selection.selected,
      carrier_title: carrierTitle,
      method_title: methodTitle,
      price: selection.price,
      items,
    };
  });

  return JSON.stringify(extShippingInfo);
}

/**
 * Show/hide loading state on the Order Summary
 * @param {boolean} loading - Whether to show loading state
 */
function setOrderSummaryLoading(loading) {
  const orderSummary = document.querySelector(`.${CLASS_ORDER_SUMMARY}`);
  if (orderSummary) {
    orderSummary.classList.toggle(CLASS_ORDER_SUMMARY_LOADING, loading);
  }
}

/**
 * Update shipping selections via GraphQL mutation
 * Note: Caller is responsible for managing loading state
 * @param {string} extShippingInfo - JSON string of shipping selections
 */
async function updateShippingSelections(extShippingInfo) {
  const { CORE_FETCH_GRAPHQL } = await import('../../commerce.js');
  const Cart = await import('@dropins/storefront-cart/api.js');
  const cartData = Cart.getCartDataFromCache();

  if (!cartData?.id) return;

  const escapedValue = extShippingInfo.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const mutation = `
    mutation SetCustomAttributesOnCart {
      setCustomAttributesOnCart(
        input: {
          cart_id: "${cartData.id}"
          custom_attributes: [
            {
              attribute_code: "${KEY_EXT_SHIPPING_INFO}"
              value: "${escapedValue}"
            }
          ]
        }
      ) {
        cart {
          id
          custom_attributes {
            attribute_code
            value
          }
        }
      }
    }
  `;

  await CORE_FETCH_GRAPHQL.fetchGraphQl(mutation, {});
  await refreshShippingEstimate();
}

/**
 * Update the displayed shipping price in the Order Summary
 * @param {number} amount - The shipping amount
 * @param {string} currency - The currency code
 */
function updateShippingPriceDisplay(amount, currency) {
  const shippingPriceEl = document.querySelector(SELECTOR_SHIPPING_PRICE);
  if (shippingPriceEl) {
    shippingPriceEl.textContent = formatPrice(amount, currency || DEFAULT_CURRENCY);
  }
}

/**
 * Get and persist the current shipping address
 * @returns {Object|null} The address object or null
 */
function getAndPersistShippingAddress() {
  const countrySelect = document.querySelector(SELECTOR_ESTIMATE_COUNTRY);
  const stateInput = document.querySelector(SELECTOR_ESTIMATE_STATE_INPUT);
  const stateSelect = document.querySelector(SELECTOR_ESTIMATE_STATE_SELECT);
  const zipInput = document.querySelector(SELECTOR_ESTIMATE_ZIP);

  if (countrySelect?.value || zipInput?.value) {
    const addressData = {
      shippingCountry: countrySelect?.value || DEFAULT_COUNTRY,
      shippingState: stateSelect?.value || stateInput?.value || '',
      shippingZip: zipInput?.value || '',
    };

    sessionStorage.setItem(STORAGE_KEY_SHIPPING_DATA, JSON.stringify(addressData));

    return {
      countryCode: addressData.shippingCountry,
      postcode: addressData.shippingZip,
      region: addressData.shippingState,
    };
  }

  const storedData = sessionStorage.getItem(STORAGE_KEY_SHIPPING_DATA);
  if (storedData) {
    try {
      const parsed = JSON.parse(storedData);
      return {
        countryCode: parsed.shippingCountry || DEFAULT_COUNTRY,
        postcode: parsed.shippingZip || '',
        region: parsed.shippingState || '',
      };
    } catch (e) {
      // Ignore parse errors
    }
  }

  return null;
}

/**
 * GraphQL mutation for shipping estimate
 */
const ESTIMATE_SHIPPING_MUTATION = `
  mutation EstimateShippingMethods($cartId: String!, $address: EstimateAddressInput!) {
    estimateShippingMethods(input: { cart_id: $cartId, address: $address }) {
      amount { currency value }
      carrier_code
      method_code
      error_message
      price_excl_tax { currency value }
      price_incl_tax { currency value }
      additional_data { key value }
    }
  }
`;

/**
 * Fetch shipping estimate with additional_data
 * @param {string} cartId - Cart ID
 * @param {Object} address - Address input
 * @returns {Promise<Array>} Shipping methods array
 */
async function fetchShippingEstimateRaw(cartId, address) {
  try {
    const { CORE_FETCH_GRAPHQL } = await import('../../commerce.js');

    const addressInput = {
      country_code: address.countryCode || address.country_code || DEFAULT_COUNTRY,
      postcode: address.postCode || address.postcode || '',
    };

    if (address.region) {
      addressInput.region = {
        region: address.region.region || address.region || '',
      };
      if (address.region.id || address.regionId) {
        addressInput.region.region_id = address.region.id || address.regionId;
      }
    }

    const response = await CORE_FETCH_GRAPHQL.fetchGraphQl(ESTIMATE_SHIPPING_MUTATION, {
      variables: { cartId, address: addressInput },
    });

    return response?.data?.estimateShippingMethods || null;
  } catch (error) {
    return null;
  }
}

/**
 * Refresh the shipping estimate
 */
async function refreshShippingEstimate() {
  try {
    const address = getAndPersistShippingAddress();
    if (!address?.postcode) return;

    const Cart = await import('@dropins/storefront-cart/api.js');
    const cartData = Cart.getCartDataFromCache();
    if (!cartData?.id) return;

    const shippingMethods = await fetchShippingEstimateRaw(cartData.id, address);
    if (!shippingMethods) return;

    const compositeMethod = shippingMethods.find(
      (m) => m.carrier_code === CARRIER_COMPOSITE && m.method_code === CARRIER_COMPOSITE,
    );

    if (compositeMethod) {
      const compositeAmount = compositeMethod.amount?.value ?? 0;
      const compositeCurrency = compositeMethod.amount?.currency ?? DEFAULT_CURRENCY;

      updateShippingPriceDisplay(compositeAmount, compositeCurrency);

      events.emit('shipping/estimate', {
        address: {
          countryCode: address.countryCode,
          region: address.region || '',
          regionId: address.regionId,
          postCode: address.postcode,
        },
        shippingMethod: {
          carrierCode: compositeMethod.carrier_code,
          methodCode: compositeMethod.method_code,
        },
      });
    }

    handleShippingEstimateResponse(shippingMethods);
  } catch (error) {
    // Silent fail
  }
}

/**
 * Create shipment header element
 * @param {number} index - Shipment index (1-based)
 * @param {number} total - Total number of shipments
 * @param {Object} source - Source object
 * @returns {HTMLElement} Shipment header element
 */
function createShipmentHeader(index, total, source) {
  const header = document.createElement('div');
  header.className = CLASS_SHIPMENT_HEADER;

  const title = document.createElement('h3');
  title.className = CLASS_SHIPMENT_HEADER_TITLE;
  title.textContent = `Shipment ${index} of ${total}`;

  const subtitle = document.createElement('div');
  subtitle.className = CLASS_SHIPMENT_HEADER_SUBTITLE;
  subtitle.textContent = `Ships from ${getSourceDisplayName(source)}`;

  header.appendChild(title);
  header.appendChild(subtitle);
  return header;
}

/**
 * Create item table header
 * @returns {HTMLElement} Table header row
 */
function createItemTableHeader() {
  const headerRow = document.createElement('div');
  headerRow.className = CLASS_SHIPMENT_ITEMS_HEADER;

  TABLE_HEADERS.forEach((col) => {
    const cell = document.createElement('div');
    cell.className = `${CLASS_SHIPMENT_ITEMS_HEADER_CELL} ${CLASS_SHIPMENT_ITEMS_HEADER_CELL}--${col.toLowerCase()}`;
    cell.textContent = col;
    headerRow.appendChild(cell);
  });

  return headerRow;
}

/**
 * Create a shipment container with real data
 * @param {number} index - Shipment index (1-based)
 * @param {number} total - Total number of shipments
 * @param {string} sourceCode - Source code
 * @param {Object} shipmentData - { source, rates, items }
 * @returns {HTMLElement} Shipment container element
 */
function createShipmentContainer(index, total, sourceCode, shipmentData) {
  const { source, rates } = shipmentData;

  const container = document.createElement('div');
  container.className = CLASS_SHIPMENT_CONTAINER;
  container.dataset.sourceCode = sourceCode;
  container.dataset.shipmentIndex = index;

  container.appendChild(createShipmentHeader(index, total, source));

  const content = document.createElement('div');
  content.className = CLASS_SHIPMENT_CONTENT;

  const itemsSection = document.createElement('div');
  itemsSection.className = CLASS_SHIPMENT_ITEMS;
  itemsSection.appendChild(createItemTableHeader());

  const itemsList = document.createElement('div');
  itemsList.className = CLASS_SHIPMENT_ITEMS_LIST;
  itemsList.dataset.sourceCode = sourceCode;
  itemsSection.appendChild(itemsList);

  content.appendChild(itemsSection);
  content.appendChild(createDeliveryOptionsElement(sourceCode, rates, index));

  container.appendChild(content);
  return container;
}

/**
 * Remove shipment UI and restore original cart display
 * @param {HTMLElement} cartList - The .cart__list element
 */
function removeShipmentUI(cartList) {
  const shipmentsContainer = cartList.querySelector(`.${CLASS_SHIPMENTS_CONTAINER}`);
  if (shipmentsContainer) {
    shipmentsContainer.remove();
  }

  const heading = cartList.querySelector(`.${CLASS_CART_SUMMARY_HEADING}`);
  if (heading) heading.style.display = '';

  const content = cartList.querySelector(`.${CLASS_CART_SUMMARY_CONTENT}`);
  if (content) content.style.display = '';
}

/**
 * Parse a price string from DOM and return numeric value
 * @param {string} priceText - Price text
 * @returns {number} Numeric price value
 */
function parsePriceFromDOM(priceText) {
  if (!priceText) return 0;

  let cleaned = priceText.replace(/[^\d.,-]/g, '').trim();
  const lastComma = cleaned.lastIndexOf(',');
  const lastPeriod = cleaned.lastIndexOf('.');

  if (lastComma > lastPeriod) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastPeriod > lastComma) {
    cleaned = cleaned.replace(/,/g, '');
  } else if (lastComma > -1) {
    cleaned = cleaned.replace(',', '.');
  }

  return parseFloat(cleaned) || 0;
}

/**
 * Scale a price by a ratio
 * @param {HTMLElement} priceElement - Element containing the price text
 * @param {number} sourceQty - Quantity for this source
 * @param {number} originalQty - Original total quantity
 * @returns {string} Scaled price with formatting
 */
function scalePriceFromElement(priceElement, sourceQty, originalQty) {
  if (!priceElement) return '';

  const originalText = priceElement.textContent || '';
  const originalValue = parsePriceFromDOM(originalText);

  if (originalValue === 0 || originalQty === 0) return originalText;

  const scaledValue = (originalValue / originalQty) * sourceQty;
  const currencyMatch = originalText.match(/^([^\d\s.,]+)\s*/);
  const currencySymbol = currencyMatch ? currencyMatch[1] : '$';
  const decimalMatch = originalText.match(/[.,](\d+)$/);
  const decimals = decimalMatch ? decimalMatch[1].length : 2;

  const formatted = scaledValue.toFixed(decimals);
  const hasCommaThousands = /\d{1,3},\d{3}/.test(originalText);
  const hasPeriodThousands = /\d{1,3}\.\d{3},/.test(originalText);

  let result = formatted;
  if (hasCommaThousands) {
    const parts = formatted.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    result = parts.join('.');
  } else if (hasPeriodThousands) {
    const parts = formatted.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    result = parts.join(',');
  }

  return `${currencySymbol}${result}`;
}

/**
 * Update cloned item to show source-specific quantity
 * @param {HTMLElement} element - Cloned cart item element
 * @param {number} sourceQty - Quantity shipping from this source
 * @param {number} originalQty - Original total quantity in cart
 */
function updateClonedItemQuantity(element, sourceQty, originalQty) {
  const qtyElement = element.querySelector(SELECTOR_CART_ITEM_QUANTITY);
  if (qtyElement) {
    const incrementer = qtyElement.querySelector(SELECTOR_QUANTITY_INPUT);
    if (incrementer) {
      incrementer.value = sourceQty;

      if (!qtyElement.querySelector(`.${CLASS_SHIPMENT_ITEM_SPLIT_NOTE}`)) {
        const splitNote = document.createElement('div');
        splitNote.className = CLASS_SHIPMENT_ITEM_SPLIT_NOTE;
        splitNote.textContent = `(of ${originalQty})`;
        qtyElement.appendChild(splitNote);
      }
    }
  }

  const regularTotalEl = element.querySelector(
    '[data-testid="regular-item-total"], [data-testid="including-tax-item-total"]',
  );
  const discountTotalEl = element.querySelector('[data-testid="discount-total"]');
  const isDiscounted = regularTotalEl && discountTotalEl;

  if (isDiscounted) {
    regularTotalEl.textContent = scalePriceFromElement(regularTotalEl, sourceQty, originalQty);
    discountTotalEl.textContent = scalePriceFromElement(discountTotalEl, sourceQty, originalQty);
  } else if (regularTotalEl) {
    regularTotalEl.textContent = scalePriceFromElement(regularTotalEl, sourceQty, originalQty);
  }
}

/**
 * Wire up the remove button to delete the item from cart
 * @param {HTMLElement} clonedElement - The cloned cart item element
 * @param {string} itemUid - The cart item UID
 */
function wireRemoveButton(clonedElement, itemUid) {
  const removeBtn = clonedElement.querySelector(SELECTOR_CART_ITEM_REMOVE);
  if (!removeBtn) return;

  const newRemoveBtn = removeBtn.cloneNode(true);
  removeBtn.parentNode.replaceChild(newRemoveBtn, removeBtn);

  newRemoveBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await removeItemFromCart(itemUid);
  });
}

/**
 * Remove an item from the cart
 * @param {string} itemUid - The cart item UID
 */
async function removeItemFromCart(itemUid) {
  setOrderSummaryLoading(true);

  try {
    const { updateProductsFromCart } = await import('@dropins/storefront-cart/api.js');
    await updateProductsFromCart([{ uid: itemUid, quantity: 0 }]);
    await refreshShippingEstimate();
  } catch (error) {
    // Silent fail
  } finally {
    setOrderSummaryLoading(false);
  }
}

/**
 * Wire up cloned quantity controls
 * @param {HTMLElement} clonedElement - The cloned cart item element
 * @param {string} itemUid - The cart item UID
 */
function wireQuantityControls(clonedElement, itemUid) {
  const clonedQty = clonedElement.querySelector(SELECTOR_CART_ITEM_QUANTITY);
  if (!clonedQty) return;

  const clonedInput = clonedQty.querySelector(SELECTOR_QUANTITY_INPUT);
  const clonedButtons = clonedQty.querySelectorAll('button');
  if (!clonedInput) return;

  let debounceTimer;
  const handleQuantityChange = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => updateItemQuantity(itemUid), DEBOUNCE_DELAY_MS);
  };

  const buttons = Array.from(clonedButtons);
  buttons.forEach((btn, index) => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const currentVal = parseInt(clonedInput.value, 10) || 0;
      if (index === 0 && currentVal > 0) {
        clonedInput.value = currentVal - 1;
        handleQuantityChange();
      } else if (index === buttons.length - 1) {
        clonedInput.value = currentVal + 1;
        handleQuantityChange();
      }
    });
  });

  clonedInput.addEventListener('change', handleQuantityChange);
  wireRemoveButton(clonedElement, itemUid);
}

/**
 * Update item quantity by summing across all shipments
 * @param {string} itemUid - The cart item UID
 */
async function updateItemQuantity(itemUid) {
  const quoteItemId = decodeCartItemUid(itemUid);
  const allWrappers = document.querySelectorAll(
    `.${CLASS_SHIPMENT_ITEM_WRAPPER}[data-quote-item-id="${quoteItemId}"]`,
  );

  let totalQty = 0;
  allWrappers.forEach((wrapper) => {
    const input = wrapper.querySelector(SELECTOR_QUANTITY_INPUT);
    if (input) {
      totalQty += parseInt(input.value, 10) || 0;
    }
  });

  setOrderSummaryLoading(true);

  try {
    const { updateProductsFromCart } = await import('@dropins/storefront-cart/api.js');
    await updateProductsFromCart([{ uid: itemUid, quantity: totalQty }]);
    await refreshShippingEstimate();
  } catch (error) {
    // Silent fail
  } finally {
    setOrderSummaryLoading(false);
  }
}

/**
 * Build new shipments UI off-DOM and swap atomically
 * @param {HTMLElement} cartList - The .cart__list element
 * @param {Object} cartData - Cart data from the API
 * @param {Object} shippingData - Parsed composite shipping data
 */
function rebuildShipmentsUI(cartList, cartData, shippingData) {
  if (!cartData?.items?.length || !shippingData?.sourceRates) return;

  const { sourceRates } = shippingData;
  const shipments = groupItemsBySourceRates(cartData.items, sourceRates);
  const totalShipments = shipments.size;

  if (totalShipments < 2) {
    removeShipmentUI(cartList);
    return;
  }

  const cartSummaryList = cartList.querySelector(`.${CLASS_CART_SUMMARY_LIST}`);
  const cartListEl = cartList.querySelector(SELECTOR_CART_LIST);

  if (!cartSummaryList || !cartListEl || cartListEl.children.length === 0) return;

  const quoteIdToData = new Map();
  cartData.items.forEach((item) => {
    const quoteItemId = decodeCartItemUid(item.uid);
    const element = cartListEl.querySelector(`[data-testid="cart-list-item-entry-${item.uid}"]`);
    if (element) {
      quoteIdToData.set(quoteItemId, { element, cartItem: item });
    }
  });

  const newShipmentsContainer = document.createElement('div');
  newShipmentsContainer.className = CLASS_SHIPMENTS_CONTAINER;

  let shipmentIndex = 1;
  shipments.forEach((shipmentData, sourceCode) => {
    const shipmentContainer = createShipmentContainer(
      shipmentIndex,
      totalShipments,
      sourceCode,
      shipmentData,
    );
    const itemsList = shipmentContainer.querySelector(`.${CLASS_SHIPMENT_ITEMS_LIST}`);

    shipmentData.items.forEach(({ cartItem, sourceQty, originalQty }) => {
      const quoteItemId = decodeCartItemUid(cartItem.uid);
      const itemData = quoteIdToData.get(quoteItemId);

      if (itemData) {
        const clonedElement = itemData.element.cloneNode(true);
        const itemWrapper = document.createElement('div');
        itemWrapper.className = CLASS_SHIPMENT_ITEM_WRAPPER;
        itemWrapper.dataset.quoteItemId = quoteItemId;
        itemWrapper.dataset.sku = cartItem.sku;
        itemWrapper.dataset.sourceQty = sourceQty;

        if (sourceQty !== originalQty) {
          updateClonedItemQuantity(clonedElement, sourceQty, originalQty);
        }

        wireQuantityControls(clonedElement, cartItem.uid);
        itemWrapper.appendChild(clonedElement);
        itemsList.appendChild(itemWrapper);
      }
    });

    newShipmentsContainer.appendChild(shipmentContainer);
    shipmentIndex += 1;
  });

  const existingContainer = cartList.querySelector(`.${CLASS_SHIPMENTS_CONTAINER}`);
  if (existingContainer) {
    existingContainer.replaceWith(newShipmentsContainer);
  } else {
    const heading = cartSummaryList.querySelector(`.${CLASS_CART_SUMMARY_HEADING}`);
    if (heading) heading.style.display = 'none';

    const content = cartSummaryList.querySelector(`.${CLASS_CART_SUMMARY_CONTENT}`);
    if (content) content.style.display = 'none';

    cartSummaryList.appendChild(newShipmentsContainer);
  }
}

/**
 * Transform the cart list into shipment groups
 * Uses MutationObserver to wait for DOM readiness instead of timers
 * @param {HTMLElement} cartList - The .cart__list element
 * @param {Object} cartData - Cart data from the API
 * @param {Object} shippingData - Parsed composite shipping data
 */
function transformCartToShipments(cartList, cartData, shippingData) {
  if (!cartData?.items?.length || !shippingData?.sourceRates) return;

  const { sourceRates } = shippingData;
  const shipments = groupItemsBySourceRates(cartData.items, sourceRates);
  const totalShipments = shipments.size;

  if (totalShipments < 2) {
    removeShipmentUI(cartList);
    return;
  }

  // Check if DOM is already ready
  const cartSummaryList = cartList.querySelector(`.${CLASS_CART_SUMMARY_LIST}`);
  const cartListEl = cartList.querySelector(SELECTOR_CART_LIST);

  if (cartSummaryList && cartListEl && cartListEl.children.length > 0) {
    rebuildShipmentsUI(cartList, cartData, shippingData);
    return;
  }

  // DOM not ready - observe for changes
  const observer = new MutationObserver((_, obs) => {
    const summaryList = cartList.querySelector(`.${CLASS_CART_SUMMARY_LIST}`);
    const listEl = cartList.querySelector(SELECTOR_CART_LIST);

    if (summaryList && listEl && listEl.children.length > 0) {
      obs.disconnect();
      rebuildShipmentsUI(cartList, cartData, shippingData);
    }
  });

  observer.observe(cartList, { childList: true, subtree: true });
}

/**
 * Handle shipping estimate response
 * @param {Array} shippingMethods - Array of shipping methods
 */
function handleShippingEstimateResponse(shippingMethods) {
  const compositeData = getCompositeShippingData(shippingMethods);

  if (compositeData) {
    currentShippingData = compositeData;

    if (currentCartData?.items?.length > 0 && cartListElement) {
      // No timer needed - rebuildShipmentsUI handles DOM readiness internally
      rebuildShipmentsUI(cartListElement, currentCartData, compositeData);
    }
  } else {
    currentShippingData = null;
    if (cartListElement) {
      removeShipmentUI(cartListElement);
    }
  }
}

/**
 * Get persisted shipping address from sessionStorage
 * @returns {Object|null} Persisted shipping data or null
 */
function getPersistedShippingAddress() {
  try {
    const data = sessionStorage.getItem(STORAGE_KEY_SHIPPING_DATA);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Persist shipping address to sessionStorage
 * @param {Object} addressData - Address data to persist
 */
function persistShippingAddress(addressData) {
  try {
    sessionStorage.setItem(STORAGE_KEY_SHIPPING_DATA, JSON.stringify(addressData));
  } catch (e) {
    // Silent fail
  }
}

/**
 * Check if customer has default shipping address
 * @returns {Promise<boolean>}
 */
async function hasCustomerDefaultAddress() {
  try {
    const isAuthenticated = localStorage.getItem(STORAGE_KEY_AUTH) === 'true';
    if (!isAuthenticated) return false;

    const Cart = await import('@dropins/storefront-cart/api.js');
    const cartData = Cart.getCartDataFromCache();
    return !!(cartData?.shippingAddresses?.length > 0);
  } catch (e) {
    return false;
  }
}

/**
 * Get address from browser geolocation + Google Geocoding API
 * @returns {Promise<Object|null>} Address object or null
 */
async function getAddressFromGeolocation() {
  const apiKey = await loadGoogleApiKey();
  if (!apiKey || !navigator.geolocation) return null;

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const { latitude, longitude } = position.coords;
          const url = `${GOOGLE_GEOCODE_URL}?latlng=${latitude},${longitude}&key=${apiKey}`;

          const response = await fetch(url);
          const data = await response.json();

          if (data.status === 'OK' && data.results?.[0]?.address_components) {
            const address = {
              shippingCountry: '',
              shippingState: '',
              shippingZip: '',
            };

            data.results[0].address_components.forEach((component) => {
              const type = component.types[0];
              if (type === 'country') {
                address.shippingCountry = component.short_name;
              } else if (type === 'administrative_area_level_1') {
                address.shippingState = component.short_name;
              } else if (type === 'postal_code') {
                address.shippingZip = component.short_name;
              }
            });

            resolve(address);
          } else {
            resolve(null);
          }
        } catch (error) {
          resolve(null);
        }
      },
      () => resolve(null),
      { timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: GEOLOCATION_MAX_AGE_MS },
    );
  });
}

/**
 * Wait for an element to appear in the DOM using MutationObserver
 * Resolves immediately if element exists, otherwise observes until it appears
 * Uses requestAnimationFrame as a fallback check to avoid hanging forever
 * @param {string} selector - CSS selector
 * @param {HTMLElement} parent - Parent element to observe
 * @param {number} maxFrames - Max animation frames to wait (default ~100 = ~1.6s at 60fps)
 * @returns {Promise<HTMLElement|null>} Resolved element or null if not found
 */
function waitForElement(selector, parent = document.body, maxFrames = 100) {
  return new Promise((resolve) => {
    const existing = parent.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    let frameCount = 0;
    let rafId;

    const observer = new MutationObserver((_, obs) => {
      const element = parent.querySelector(selector);
      if (element) {
        cancelAnimationFrame(rafId);
        obs.disconnect();
        resolve(element);
      }
    });

    observer.observe(parent, { childList: true, subtree: true });

    // Fallback: check periodically via rAF in case MutationObserver misses something
    const checkFrame = () => {
      frameCount += 1;
      const element = parent.querySelector(selector);
      if (element) {
        observer.disconnect();
        resolve(element);
        return;
      }
      if (frameCount >= maxFrames) {
        observer.disconnect();
        resolve(null); // Give up after max frames
        return;
      }
      rafId = requestAnimationFrame(checkFrame);
    };
    rafId = requestAnimationFrame(checkFrame);
  });
}

/**
 * Wait for state field to appear after country selection
 * Uses MutationObserver on the form container to detect when state field renders
 * Resolves with null if no state field appears after observing a DOM update cycle
 * @param {HTMLElement} formContainer - The form or parent container
 * @returns {Promise<HTMLElement|null>} State field or null
 */
function waitForStateField(formContainer) {
  return new Promise((resolve) => {
    // Check if already exists
    const existing = formContainer.querySelector(SELECTOR_ESTIMATE_STATE_SELECT)
      || formContainer.querySelector(SELECTOR_ESTIMATE_STATE_INPUT);
    if (existing) {
      resolve(existing);
      return;
    }

    let mutationCount = 0;

    // Observe for state field to appear
    const observer = new MutationObserver((_, obs) => {
      const stateField = formContainer.querySelector(SELECTOR_ESTIMATE_STATE_SELECT)
        || formContainer.querySelector(SELECTOR_ESTIMATE_STATE_INPUT);
      if (stateField) {
        obs.disconnect();
        resolve(stateField);
        return;
      }

      // After seeing DOM changes, if still no state field, country likely has no states
      mutationCount += 1;
      if (mutationCount >= 2) {
        obs.disconnect();
        resolve(null);
      }
    });

    observer.observe(formContainer, { childList: true, subtree: true });
  });
}

/**
 * Apply address data to the EstimateShipping form
 * @param {Object} addressData - Address data
 * @param {boolean} autoSubmit - Whether to auto-submit
 */
async function applyAddressToForm(addressData, autoSubmit = false) {
  if (!addressData) return;

  // Get form fields - check if already present
  const countrySelect = document.querySelector(SELECTOR_ESTIMATE_COUNTRY);
  const zipInput = document.querySelector(SELECTOR_ESTIMATE_ZIP);

  // If form isn't rendered yet, wait for country selector as our signal
  if (!countrySelect) {
    const renderedCountry = await waitForElement(SELECTOR_ESTIMATE_COUNTRY);
    if (!renderedCountry) return;
    await applyAddressToForm(addressData, autoSubmit); // Recurse with rendered form
    return;
  }

  // Get the form container for observing state field changes
  const formContainer = countrySelect.closest('form') || countrySelect.parentElement;

  // Set country first (this triggers state field rendering for countries with states)
  if (addressData.shippingCountry) {
    countrySelect.value = addressData.shippingCountry;
    countrySelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Set zip code
  if (zipInput && addressData.shippingZip) {
    zipInput.value = addressData.shippingZip;
    zipInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Wait for and set state if provided
  if (addressData.shippingState && formContainer) {
    const stateField = await waitForStateField(formContainer);
    if (stateField) {
      stateField.value = addressData.shippingState;
      const eventType = stateField.tagName === 'SELECT' ? 'change' : 'input';
      stateField.dispatchEvent(new Event(eventType, { bubbles: true }));
    }
  }

  // Submit the form
  if (autoSubmit) {
    const applyButton = document.querySelector(SELECTOR_ESTIMATE_APPLY);
    if (applyButton) applyButton.click();
  }
}

/**
 * Initialize shipping address persistence and geolocation
 */
async function initShippingAddressPersistence() {
  const persistedAddress = getPersistedShippingAddress();

  if (persistedAddress?.shippingZip) {
    applyAddressToForm(persistedAddress, true);
    return;
  }

  const hasDefaultAddress = await hasCustomerDefaultAddress();
  if (hasDefaultAddress) return;

  const geoAddress = await getAddressFromGeolocation();
  if (geoAddress?.shippingZip) {
    persistShippingAddress(geoAddress);
    applyAddressToForm(geoAddress, true);
  }
}

/**
 * Initialize cart shipments functionality
 * @param {HTMLElement} cartList - The .cart__list element
 */
export function initCartShipments(cartList) {
  cartListElement = cartList;

  events.on('cart/data', async (cartData) => {
    currentCartData = cartData;

    if (!shippingPersistenceInitialized && cartData?.id) {
      shippingPersistenceInitialized = true;
      await initShippingAddressPersistence();
    }

    if (currentShippingData && cartData?.items?.length > 0) {
      transformCartToShipments(cartList, cartData, currentShippingData);
    }
  }, { eager: true });

  events.on('shipping/estimate', async (data) => {
    if (!data?.address) return;

    persistShippingAddress({
      shippingCountry: data.address.countryCode || DEFAULT_COUNTRY,
      shippingState: data.address.region || '',
      shippingZip: data.address.postCode || '',
    });

    const Cart = await import('@dropins/storefront-cart/api.js');
    const cartData = Cart.getCartDataFromCache();
    if (!cartData?.id) return;

    const shippingMethods = await fetchShippingEstimateRaw(cartData.id, data.address);
    if (shippingMethods) {
      handleShippingEstimateResponse(shippingMethods);
    }
  });
}

// Named exports for testing
export {
  getCompositeShippingData,
  groupItemsBySourceRates,
};

export default {
  initCartShipments,
  transformCartToShipments,
  getCompositeShippingData,
  groupItemsBySourceRates,
};
