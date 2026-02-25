/**
 * Cart Shipments Module
 * Groups cart items by source/warehouse and displays them as separate shipments
 * with delivery options for each shipment.
 *
 * This module integrates with the Multi-Source Inventory (MSI) shipping system
 * that returns composite shipping rates with per-source delivery options.
 */

import { events } from '@dropins/tools/event-bus.js';

// Module state
let currentCartData = null;
let currentShippingData = null;
let cartListElement = null;
let lastRawShippingResponse = null;

// Expose state for debugging
window.__cartShipmentsDebug = {
  get cartData() { return currentCartData; },
  get shippingData() { return currentShippingData; },
  get cartListElement() { return cartListElement; },
  get rawResponse() { return lastRawShippingResponse; },
  // Manual trigger for testing
  triggerWithMockData: () => {
    if (cartListElement && currentCartData) {
      // eslint-disable-next-line no-use-before-define
      renderShipmentsWithMockData();
    }
  },
  // Set raw response manually for testing
  setRawResponse: (response) => {
    lastRawShippingResponse = response;
    // eslint-disable-next-line no-use-before-define
    processRawShippingResponse(response);
  },
};

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

  // Find composite carrier method
  const compositeMethod = shippingMethods.find(
    (method) => method.carrier_code === 'composite' && method.method_code === 'composite',
  );

  if (!compositeMethod || !compositeMethod.additional_data) {
    return null;
  }

  // Find source_rates in additional_data
  const sourceRatesData = compositeMethod.additional_data.find(
    (data) => data.key === 'source_rates',
  );

  if (!sourceRatesData || !sourceRatesData.value) {
    return null;
  }

  try {
    const sourceRates = JSON.parse(sourceRatesData.value);
    // Check if there's more than one source
    const sourceCount = Object.keys(sourceRates).length;
    if (sourceCount < 2) {
      return null; // Don't show shipment grouping for single source
    }
    return {
      method: compositeMethod,
      sourceRates,
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[CartShipments] Failed to parse source_rates:', e);
    return null;
  }
}

/**
 * Group cart items by source based on shipping estimate response
 * @param {Array} cartItems - Cart items from cart data
 * @param {Object} sourceRates - Parsed source_rates from shipping estimate
 * @returns {Map} Map of sourceCode -> { source, rates, items: [{ cartItem, qty }] }
 */
function groupItemsBySourceRates(cartItems, sourceRates) {
  const shipments = new Map();

  // Create maps for flexible lookup - by quote ID and by SKU
  const itemIdToCartItem = new Map();
  const skuToCartItem = new Map();

  cartItems.forEach((item) => {
    const quoteItemId = decodeCartItemUid(item.uid);
    itemIdToCartItem.set(quoteItemId, item);
    skuToCartItem.set(item.sku, item);
  });

  // Process each source from the shipping response
  // IMPORTANT: Keep all sources even if we can't find items (we'll show the delivery options)
  Object.entries(sourceRates).forEach(([sourceCode, sourceData]) => {
    const { source, rates, items } = sourceData;

    const shipmentItems = [];

    // Map items to cart items with their quantities for this source
    Object.entries(items).forEach(([quoteItemId, qty]) => {
      // Try finding by quote ID first
      const cartItem = itemIdToCartItem.get(quoteItemId);

      if (cartItem) {
        shipmentItems.push({
          cartItem,
          sourceQty: qty,
          originalQty: cartItem.quantity,
        });
      }
    });

    // Always add the shipment even with 0 items (to show delivery options)
    // But only if we have at least one item matched across all sources
    shipments.set(sourceCode, {
      source,
      rates,
      items: shipmentItems,
    });
  });

  return shipments;
}

/**
 * Format price for display
 * @param {number} price - Price value
 * @param {string} currency - Currency code
 * @returns {string} Formatted price
 */
function formatPrice(price, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
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
  if (!source) return 'Unknown Location';
  const parts = [source.city, source.region].filter(Boolean);
  return parts.join(', ') || source.name || 'Unknown Location';
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
  container.className = 'shipment-delivery-options';

  const heading = document.createElement('div');
  heading.className = 'shipment-delivery-options__heading';
  heading.textContent = 'Delivery Options';
  container.appendChild(heading);

  const content = document.createElement('div');
  content.className = 'shipment-delivery-options__content';

  const label = document.createElement('div');
  label.className = 'shipment-delivery-options__label';
  label.textContent = 'Choose your delivery option:';
  content.appendChild(label);

  // Create form for this source's shipping options
  const form = document.createElement('form');
  form.className = 'shipment-delivery-options__form';
  form.dataset.sourceCode = sourceCode;

  // Flatten all rates from different carriers into options
  let optionIndex = 0;
  let hasSelectedOption = false;

  Object.entries(rates).forEach(([_carrierCode, carrierRates]) => {
    carrierRates.forEach((rate) => {
      const optionEl = document.createElement('div');
      optionEl.className = 'shipment-delivery-option';

      const radioId = `delivery-${shipmentIndex}-${optionIndex}`;
      const radioValue = rate.code; // e.g., "flatrate_flatrate"

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `shipping_method_${sourceCode}`;
      radio.id = radioId;
      radio.value = radioValue;
      radio.dataset.sourceCode = sourceCode;
      radio.dataset.carrierCode = rate.carrier;
      radio.dataset.methodCode = rate.method;
      radio.dataset.price = rate.price;

      // Check if this option is selected
      if (rate.selected) {
        radio.checked = true;
        hasSelectedOption = true;
      }

      // Add change handler
      radio.addEventListener('change', handleDeliveryOptionChange);

      const labelEl = document.createElement('label');
      labelEl.htmlFor = radioId;
      labelEl.className = 'shipment-delivery-option__label';

      const methodSpan = document.createElement('span');
      methodSpan.className = 'shipment-delivery-option__method';
      methodSpan.textContent = rate.method_title || rate.carrier_title || 'Standard Shipping';

      const priceSpan = document.createElement('span');
      priceSpan.className = 'shipment-delivery-option__price';
      priceSpan.textContent = formatPrice(rate.price);

      labelEl.appendChild(methodSpan);
      labelEl.appendChild(priceSpan);

      optionEl.appendChild(radio);
      optionEl.appendChild(labelEl);
      form.appendChild(optionEl);

      optionIndex += 1;
    });
  });

  // If no option was pre-selected, select the first one
  if (!hasSelectedOption && form.querySelector('input[type="radio"]')) {
    form.querySelector('input[type="radio"]').checked = true;
  }

  content.appendChild(form);
  container.appendChild(content);
  return container;
}

/**
 * Handle delivery option change
 * @param {Event} event - Change event
 */
async function handleDeliveryOptionChange(_event) {
  // Collect all selected shipping methods per source
  const sourceSelections = collectSourceSelections();

  // Build ext_shipping_info payload
  const extShippingInfo = buildExtShippingInfo(sourceSelections);

  // Fire mutation to save selections and refresh shipping estimate
  await updateShippingSelections(extShippingInfo);
}

/**
 * Collect all selected shipping methods across all sources
 * @returns {Object} Map of sourceCode -> selected method info
 */
function collectSourceSelections() {
  const selections = {};
  const forms = document.querySelectorAll('.shipment-delivery-options__form');

  forms.forEach((form) => {
    const { sourceCode } = form.dataset;
    const selectedRadio = form.querySelector('input[type="radio"]:checked');

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
    // Get items for this source from current shipping data
    const sourceData = currentShippingData?.sourceRates?.[sourceCode];
    const items = {};

    if (sourceData?.items) {
      // Convert quote item IDs to SKUs for the payload
      Object.entries(sourceData.items).forEach(([quoteItemId, qty]) => {
        // Find the cart item to get SKU
        const cartItem = currentCartData?.items?.find(
          (item) => decodeCartItemUid(item.uid) === quoteItemId,
        );
        if (cartItem) {
          items[cartItem.sku] = qty;
        }
      });
    }

    // Find the selected rate to get carrier/method titles
    let carrierTitle = 'Choose your delivery option:';
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
 * Show loading state on the Order Summary
 * Mimics what the EstimateShipping Apply button does
 * @param {boolean} loading - Whether to show loading state
 */
function setOrderSummaryLoading(loading) {
  const orderSummary = document.querySelector('.cart-order-summary');
  if (orderSummary) {
    if (loading) {
      orderSummary.classList.add('cart-order-summary--loading');
    } else {
      orderSummary.classList.remove('cart-order-summary--loading');
    }
  }
}

/**
 * Update shipping selections via GraphQL mutation
 * This MUST be called FIRST when customer changes delivery option,
 * so the composite total can be calculated correctly.
 * @param {string} extShippingInfo - JSON string of shipping selections
 */
async function updateShippingSelections(extShippingInfo) {
  try {
    // Show loading state on Order Summary (like Apply button does)
    setOrderSummaryLoading(true);

    // Import the GraphQL fetch utility
    const { CORE_FETCH_GRAPHQL } = await import('../../commerce.js');

    // Get cart ID from the cart API
    const Cart = await import('@dropins/storefront-cart/api.js');
    const cartData = Cart.getCartDataFromCache();

    if (!cartData?.id) {
      setOrderSummaryLoading(false);
      return;
    }

    // Use inline values instead of variables - the CartCustomAttributeInput type
    // may not be declared in the schema, so we build the mutation dynamically
    const escapedValue = extShippingInfo.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const mutation = `
      mutation SetCustomAttributesOnCart {
        setCustomAttributesOnCart(
          input: {
            cart_id: "${cartData.id}"
            custom_attributes: [
              {
                attribute_code: "ext_shipping_info"
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

    // After updating ext_shipping_info, trigger shipping estimate refresh
    // This will recalculate the composite shipping total
    await refreshShippingEstimate();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[CartShipments] Failed to update shipping selections:', error);
  } finally {
    // Hide loading state
    setOrderSummaryLoading(false);
  }
}

/**
 * Update the displayed shipping price in the Order Summary
 * This directly updates the DOM to show the composite shipping total
 * @param {number} amount - The shipping amount
 * @param {string} currency - The currency code
 */
function updateShippingPriceDisplay(amount, currency) {
  // Find the shipping price element in the estimate shipping component
  const shippingPriceEl = document.querySelector('.cart-estimate-shipping__price');
  if (shippingPriceEl) {
    // Format the price
    const formattedPrice = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(amount);

    // Update the display
    shippingPriceEl.textContent = formattedPrice;
  }
}

/**
 * Get and persist the current shipping address
 * Reads from form fields and ensures it's saved to sessionStorage
 * @returns {Object|null} The address object or null if not available
 */
function getAndPersistShippingAddress() {
  // First try to get from the form (most up-to-date source)
  const countrySelect = document.querySelector('[data-testid="estimate-shipping-country-selector"]');
  const stateInput = document.querySelector('[data-testid="estimate-shipping-state-input"]');
  const stateSelect = document.querySelector('[data-testid="estimate-shipping-state-selector"]');
  const zipInput = document.querySelector('[data-testid="estimate-shipping-zip-input"]');

  // If form has values, use them
  if (countrySelect?.value || zipInput?.value) {
    const addressData = {
      shippingCountry: countrySelect?.value || 'US',
      shippingState: stateSelect?.value || stateInput?.value || '',
      shippingZip: zipInput?.value || '',
    };

    // Persist to sessionStorage (same format as dropin uses)
    sessionStorage.setItem('DROPIN__CART__SHIPPING__DATA', JSON.stringify(addressData));

    return {
      countryCode: addressData.shippingCountry,
      postcode: addressData.shippingZip,
      region: addressData.shippingState,
    };
  }

  // Fall back to sessionStorage
  const storedData = sessionStorage.getItem('DROPIN__CART__SHIPPING__DATA');
  if (storedData) {
    try {
      const parsed = JSON.parse(storedData);
      return {
        countryCode: parsed.shippingCountry || 'US',
        postcode: parsed.shippingZip || '',
        region: parsed.shippingState || '',
      };
    } catch (e) {
      // Ignore parse errors - will return null
    }
  }

  return null;
}

/**
 * Refresh the shipping estimate after updating selections
 * Uses the stored address from sessionStorage or the estimate form
 */
async function refreshShippingEstimate() {
  try {
    // Get address, prioritizing form values and ensuring persistence
    const address = getAndPersistShippingAddress();

    if (!address || !address.postcode) {
      return;
    }

    // Get cart ID
    const Cart = await import('@dropins/storefront-cart/api.js');
    const cartData = Cart.getCartDataFromCache();

    if (!cartData?.id || !address) {
      return;
    }

    // Fetch fresh shipping estimate
    const shippingMethods = await fetchShippingEstimateRaw(cartData.id, address);

    if (shippingMethods) {
      lastRawShippingResponse = shippingMethods;

      // Find the composite method to get the new shipping total
      const compositeMethod = shippingMethods.find(
        (m) => m.carrier_code === 'composite' && m.method_code === 'composite',
      );

      if (compositeMethod) {
        // Get the composite shipping amount
        const compositeAmount = compositeMethod.amount?.value ?? 0;
        const compositeCurrency = compositeMethod.amount?.currency ?? 'USD';

        // Directly update the shipping price display with the composite amount
        // This ensures the correct price shows regardless of what estimateTotals returns
        updateShippingPriceDisplay(compositeAmount, compositeCurrency);

        // Emit shipping/estimate event - this triggers getEstimatedTotals
        // for the other totals (subtotal, tax, grand total)
        // The shipping_method we pass should tell the backend to use composite pricing
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

      // Update our shipments UI with new shipping data
      handleShippingEstimateResponse(shippingMethods);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[CartShipments] Failed to refresh shipping estimate:', error);
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
  header.className = 'shipment-header';

  const title = document.createElement('h3');
  title.className = 'shipment-header__title';
  title.textContent = `Shipment ${index} of ${total}`;

  const subtitle = document.createElement('div');
  subtitle.className = 'shipment-header__subtitle';
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
  headerRow.className = 'shipment-items__header';

  const cols = ['Item', 'Price', 'Qty', 'Subtotal'];
  cols.forEach((col) => {
    const cell = document.createElement('div');
    const colClass = `shipment-items__header-cell shipment-items__header-cell--${col.toLowerCase()}`;
    cell.className = colClass;
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
  container.className = 'shipment-container';
  container.dataset.sourceCode = sourceCode;
  container.dataset.shipmentIndex = index;

  // Shipment header
  const header = createShipmentHeader(index, total, source);
  container.appendChild(header);

  // Main content area with items and delivery options
  const content = document.createElement('div');
  content.className = 'shipment-content';

  // Items section
  const itemsSection = document.createElement('div');
  itemsSection.className = 'shipment-items';

  // Table header
  itemsSection.appendChild(createItemTableHeader());

  // Items list placeholder - will be populated with cloned cart items
  const itemsList = document.createElement('div');
  itemsList.className = 'shipment-items__list';
  itemsList.dataset.sourceCode = sourceCode;
  itemsSection.appendChild(itemsList);

  content.appendChild(itemsSection);

  // Delivery options section
  const deliveryOptions = createDeliveryOptionsElement(sourceCode, rates, index);
  content.appendChild(deliveryOptions);

  container.appendChild(content);
  return container;
}

/**
 * Transform the cart list into shipment groups using real shipping data
 * @param {HTMLElement} cartList - The .cart__list element
 * @param {Object} cartData - Cart data from the API
 * @param {Object} shippingData - Parsed composite shipping data
 */
function transformCartToShipments(cartList, cartData, shippingData) {
  if (!cartData?.items?.length || !shippingData?.sourceRates) {
    return;
  }

  const { sourceRates } = shippingData;
  const shipments = groupItemsBySourceRates(cartData.items, sourceRates);
  const totalShipments = shipments.size;

  if (totalShipments < 2) {
    // Don't transform for single source
    removeShipmentUI(cartList);
    return;
  }

  // Wait for the dropin to render its content
  const observer = new MutationObserver((_mutations, obs) => {
    const cartSummaryList = cartList.querySelector('.cart-cart-summary-list');
    const cartListEl = cartList.querySelector('[data-testid="cart-list"]');

    if (cartSummaryList && cartListEl && cartListEl.children.length > 0) {
      obs.disconnect();
      reorganizeIntoShipments({
        cartList, cartSummaryList, cartListEl, cartData, shipments, totalShipments,
      });
    }
  });

  observer.observe(cartList, { childList: true, subtree: true });

  // Also check immediately in case content is already rendered
  const cartSummaryList = cartList.querySelector('.cart-cart-summary-list');
  const cartListEl = cartList.querySelector('[data-testid="cart-list"]');
  if (cartSummaryList && cartListEl && cartListEl.children.length > 0) {
    observer.disconnect();
    reorganizeIntoShipments({
      cartList, cartSummaryList, cartListEl, cartData, shipments, totalShipments,
    });
  }
}

/**
 * Remove shipment UI and restore original cart display
 * @param {HTMLElement} cartList - The .cart__list element
 */
function removeShipmentUI(cartList) {
  const shipmentsContainer = cartList.querySelector('.shipments-container');
  if (shipmentsContainer) {
    shipmentsContainer.remove();
  }

  // Show original heading if it was hidden
  const heading = cartList.querySelector('.cart-cart-summary-list__heading');
  if (heading) {
    heading.style.display = '';
  }

  // Show original content if it was hidden
  const content = cartList.querySelector('.cart-cart-summary-list__content');
  if (content) {
    content.style.display = '';
  }
}

/**
 * Reorganize rendered cart items into shipment groups
 * Following the approach from the PHP/VanillaJS implementation:
 * - Iterate over sourceRates directly
 * - Find DOM elements by data-testid attribute (dropin uses cart-list-item-entry-{uid})
 * - Clone entire item elements for each source
 * @param {Object} ctx - Context object with all required data
 */
function reorganizeIntoShipments(ctx) {
  const {
    cartList, cartSummaryList, cartListEl, cartData, shipments, totalShipments,
  } = ctx;

  // Check if already transformed
  if (cartList.querySelector('.shipments-container')) {
    return;
  }

  // Build a map from quoteItemId to { element, cartItem }
  // The dropin renders items with data-testid="cart-list-item-entry-{uid}"
  // where uid is the base64 encoded quote item ID
  const quoteIdToData = new Map();

  cartData.items.forEach((item) => {
    const quoteItemId = decodeCartItemUid(item.uid);
    // Find element by data-testid using the original uid (base64)
    const element = cartListEl.querySelector(`[data-testid="cart-list-item-entry-${item.uid}"]`);

    if (element) {
      quoteIdToData.set(quoteItemId, { element, cartItem: item });
    }
  });

  // Create shipments container
  const shipmentsContainer = document.createElement('div');
  shipmentsContainer.className = 'shipments-container';

  let shipmentIndex = 1;
  shipments.forEach((shipmentData, sourceCode) => {
    const shipmentContainer = createShipmentContainer(
      shipmentIndex,
      totalShipments,
      sourceCode,
      shipmentData,
    );
    const itemsList = shipmentContainer.querySelector('.shipment-items__list');

    // Clone and add items to this shipment
    shipmentData.items.forEach(({ cartItem, sourceQty, originalQty }) => {
      const quoteItemId = decodeCartItemUid(cartItem.uid);
      const itemData = quoteIdToData.get(quoteItemId);

      if (itemData) {
        // Clone the rendered item
        const clonedElement = itemData.element.cloneNode(true);
        const itemWrapper = document.createElement('div');
        itemWrapper.className = 'shipment-item-wrapper';
        itemWrapper.dataset.quoteItemId = quoteItemId;
        itemWrapper.dataset.sku = cartItem.sku;
        itemWrapper.dataset.sourceQty = sourceQty;

        // Update quantity display if it's a split item
        if (sourceQty !== originalQty) {
          updateClonedItemQuantity(clonedElement, sourceQty, originalQty);
        }

        // Wire up cloned quantity controls to update cart via native API
        wireQuantityControls(clonedElement, cartItem.uid);

        itemWrapper.appendChild(clonedElement);
        itemsList.appendChild(itemWrapper);
      }
    });

    shipmentsContainer.appendChild(shipmentContainer);
    shipmentIndex += 1;
  });

  // Hide the original heading if present
  const heading = cartSummaryList.querySelector('.cart-cart-summary-list__heading');
  if (heading) {
    heading.style.display = 'none';
  }

  // Hide the original cart list content (don't remove - dropin needs it for updates)
  const content = cartSummaryList.querySelector('.cart-cart-summary-list__content');
  if (content) {
    content.style.display = 'none';
    // Append shipments container as sibling (not replacing content)
    cartSummaryList.appendChild(shipmentsContainer);
  }
}

/**
 * Wire up cloned quantity controls to update the cart via native API
 * When user changes quantity, we sum up total for that item and call updateProductsFromCart
 * @param {HTMLElement} clonedElement - The cloned cart item element
 * @param {string} itemUid - The cart item UID (base64 encoded)
 */
function wireQuantityControls(clonedElement, itemUid) {
  const clonedQty = clonedElement.querySelector('.dropin-cart-item__quantity');
  if (!clonedQty) return;

  const clonedInput = clonedQty.querySelector('input[name="quantity"]');
  const clonedButtons = clonedQty.querySelectorAll('button');

  if (!clonedInput) return;

  // Debounce timer to prevent multiple rapid calls
  let debounceTimer;

  const handleQuantityChange = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      updateItemQuantity(itemUid);
    }, 300);
  };

  // Wire up buttons (first = decrement, last = increment)
  const buttons = Array.from(clonedButtons);
  buttons.forEach((btn, index) => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const currentVal = parseInt(clonedInput.value, 10) || 0;
      if (index === 0 && currentVal > 0) {
        // Decrement
        clonedInput.value = currentVal - 1;
        handleQuantityChange();
      } else if (index === buttons.length - 1) {
        // Increment
        clonedInput.value = currentVal + 1;
        handleQuantityChange();
      }
    });
  });

  // Wire up input change
  clonedInput.addEventListener('change', handleQuantityChange);

  // Wire up remove button (trashcan icon)
  wireRemoveButton(clonedElement, itemUid);
}

/**
 * Wire up the remove button to delete the entire item from cart
 * Uses the same approach as the native dropin: updateProductsFromCart with quantity 0
 * @param {HTMLElement} clonedElement - The cloned cart item element
 * @param {string} itemUid - The cart item UID (base64 encoded)
 */
function wireRemoveButton(clonedElement, itemUid) {
  const removeBtn = clonedElement.querySelector('.dropin-cart-item__remove');
  if (!removeBtn) return;

  // Clone and replace to remove any existing event listeners
  const newRemoveBtn = removeBtn.cloneNode(true);
  removeBtn.parentNode.replaceChild(newRemoveBtn, removeBtn);

  newRemoveBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Remove entire item from cart using native dropin API (quantity = 0)
    await removeItemFromCart(itemUid);
  });
}

/**
 * Remove an item entirely from the cart
 * Uses the same method as the native dropin: updateProductsFromCart with quantity 0
 * @param {string} itemUid - The cart item UID (base64 encoded)
 */
async function removeItemFromCart(itemUid) {
  setOrderSummaryLoading(true);

  try {
    const { updateProductsFromCart } = await import('@dropins/storefront-cart/api.js');

    // Setting quantity to 0 removes the item (same as native dropin)
    await updateProductsFromCart([{
      uid: itemUid,
      quantity: 0,
    }]);

    // The dropin emits cart/data event which triggers our rebuild
    // Also refresh shipping estimate to get new source allocations
    await refreshShippingEstimate();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[CartShipments] Failed to remove item from cart:', error);
  } finally {
    setOrderSummaryLoading(false);
  }
}

/**
 * Update item quantity by summing across all shipments and calling native API
 * @param {string} itemUid - The cart item UID (base64 encoded)
 */
async function updateItemQuantity(itemUid) {
  const quoteItemId = decodeCartItemUid(itemUid);

  // Find all shipment wrappers for this item
  const allWrappers = document.querySelectorAll(
    `.shipment-item-wrapper[data-quote-item-id="${quoteItemId}"]`,
  );

  // Sum up all quantities from inputs
  let totalQty = 0;
  allWrappers.forEach((wrapper) => {
    const input = wrapper.querySelector('input[name="quantity"]');
    if (input) {
      totalQty += parseInt(input.value, 10) || 0;
    }
  });

  // Show loading state
  setOrderSummaryLoading(true);

  try {
    // Use the native dropin API to update the cart
    const { updateProductsFromCart } = await import('@dropins/storefront-cart/api.js');

    await updateProductsFromCart([{
      uid: itemUid,
      quantity: totalQty,
    }]);

    // After cart update, refresh shipping estimate to get new source allocations
    // This will trigger handleShippingEstimateResponse which rebuilds the UI
    await refreshShippingEstimate();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[CartShipments] Failed to update item quantity:', error);
  } finally {
    setOrderSummaryLoading(false);
  }
}

/**
 * Parse a price string from DOM and return numeric value
 * Handles various currency formats and locales
 * @param {string} priceText - Price text like "$884.00" or "€1.234,56"
 * @returns {number} Numeric price value
 */
function parsePriceFromDOM(priceText) {
  if (!priceText) return 0;

  // Remove currency symbols and whitespace (keep digits, commas, periods, minus)
  let cleaned = priceText.replace(/[^\d.,-]/g, '').trim();

  // Handle different decimal separators
  // If there's both comma and period, the last one is likely the decimal separator
  const lastComma = cleaned.lastIndexOf(',');
  const lastPeriod = cleaned.lastIndexOf('.');

  if (lastComma > lastPeriod) {
    // European format: 1.234,56 → remove periods, replace comma with period
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastPeriod > lastComma) {
    // US format: 1,234.56 → remove commas
    cleaned = cleaned.replace(/,/g, '');
  } else if (lastComma > -1) {
    // Only comma, could be decimal: 1234,56 → replace comma with period
    cleaned = cleaned.replace(',', '.');
  }

  return parseFloat(cleaned) || 0;
}

/**
 * Scale a price by a ratio (sourceQty / originalQty)
 * Preserves the original formatting from the DOM element
 * @param {HTMLElement} priceElement - Element containing the price text
 * @param {number} sourceQty - Quantity for this source
 * @param {number} originalQty - Original total quantity
 * @returns {string} Scaled price with same formatting
 */
function scalePriceFromElement(priceElement, sourceQty, originalQty) {
  if (!priceElement) return '';

  const originalText = priceElement.textContent || '';
  const originalValue = parsePriceFromDOM(originalText);

  if (originalValue === 0 || originalQty === 0) return originalText;

  // Scale the price: (originalTotal / originalQty) * sourceQty
  const scaledValue = (originalValue / originalQty) * sourceQty;

  // Try to preserve the original currency format
  // Extract currency symbol and format from the original text
  const currencyMatch = originalText.match(/^([^\d\s.,]+)\s*/);
  const currencySymbol = currencyMatch ? currencyMatch[1] : '$';

  // Format with same decimal places as original
  const decimalMatch = originalText.match(/[.,](\d+)$/);
  const decimals = decimalMatch ? decimalMatch[1].length : 2;

  // Format the number
  const formatted = scaledValue.toFixed(decimals);

  // Add thousands separators based on original format
  const hasCommaThousands = /\d{1,3},\d{3}/.test(originalText);
  const hasPeriodThousands = /\d{1,3}\.\d{3},/.test(originalText);

  let result = formatted;
  if (hasCommaThousands) {
    // US format: add commas
    const parts = formatted.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    result = parts.join('.');
  } else if (hasPeriodThousands) {
    // European format: add periods, use comma for decimal
    const parts = formatted.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    result = parts.join(',');
  }

  return `${currencySymbol}${result}`;
}

/**
 * Update cloned item to show source-specific quantity
 * For split items, we show:
 * - Unit price stays as-is: "$34.00 each"
 * - Quantity display updated to source qty, with "(of X)" note
 * - Line item subtotal scaled by quantity ratio
 * - Prices are READ FROM THE DOM and scaled proportionally
 * - Quantity controls are DISABLED - users adjust via original hidden cart
 * @param {HTMLElement} element - Cloned cart item element
 * @param {number} sourceQty - Quantity shipping from this source
 * @param {number} originalQty - Original total quantity in cart
 */
function updateClonedItemQuantity(element, sourceQty, originalQty) {
  // Find quantity display/input
  const qtyElement = element.querySelector('.dropin-cart-item__quantity');
  if (qtyElement) {
    // Find the incrementer or quantity display
    const incrementer = qtyElement.querySelector('input[name="quantity"]');
    if (incrementer) {
      // Set value but DO NOT disable - customer can adjust qty
      // When they update, quantities will be summed across all sources
      incrementer.value = sourceQty;

      // Add a note showing this is part of a larger order below the qty input
      if (!qtyElement.querySelector('.shipment-item-split-note')) {
        const splitNote = document.createElement('div');
        splitNote.className = 'shipment-item-split-note';
        splitNote.textContent = `(of ${originalQty})`;
        qtyElement.appendChild(splitNote);
      }
    }
  }

  // Find the regular total element (strikethrough price for discounted items)
  // data-testid="regular-item-total" or "including-tax-item-total"
  const regularTotalEl = element.querySelector(
    '[data-testid="regular-item-total"], [data-testid="including-tax-item-total"]',
  );

  // Find the discount total element (sale price)
  // data-testid="discount-total"
  const discountTotalEl = element.querySelector('[data-testid="discount-total"]');

  // Check if this item is discounted (has both regular and discount totals)
  const isDiscounted = regularTotalEl && discountTotalEl;

  if (isDiscounted) {
    // Scale both prices from DOM values
    const scaledRegular = scalePriceFromElement(regularTotalEl, sourceQty, originalQty);
    const scaledDiscount = scalePriceFromElement(discountTotalEl, sourceQty, originalQty);

    // Update the regular total (strikethrough)
    regularTotalEl.textContent = scaledRegular;

    // Update the discount total (sale price)
    discountTotalEl.textContent = scaledDiscount;
  } else if (regularTotalEl) {
    // No discount - just scale the regular total
    const scaledPrice = scalePriceFromElement(regularTotalEl, sourceQty, originalQty);
    regularTotalEl.textContent = scaledPrice;
  }
}

/**
 * Process raw shipping response from GraphQL
 * @param {Object} response - Raw estimateShippingMethods response
 */
function processRawShippingResponse(response) {
  if (!response) return;

  lastRawShippingResponse = response;
  const shippingMethods = Array.isArray(response) ? response : [response];
  handleShippingEstimateResponse(shippingMethods);
}

/**
 * Render shipments with mock data for testing
 */
function renderShipmentsWithMockData() {
  // Mock data matching your response format
  const mockSourceRates = {
    'warehouse-east': {
      source: {
        source_code: 'warehouse-east',
        name: 'East Warehouse',
        city: 'Atlanta',
        region: 'Georgia',
        country_id: 'US',
      },
      rates: {
        flatrate: [{
          code: 'flatrate_flatrate',
          carrier: 'flatrate',
          carrier_title: 'Flat Rate',
          method: 'flatrate',
          method_title: 'Fixed',
          price: 5,
          selected: true,
        }],
      },
      items: { 1: 2 },
    },
    'warehouse-west': {
      source: {
        source_code: 'warehouse-west',
        name: 'West Warehouse',
        city: 'Los Angeles',
        region: 'California',
        country_id: 'US',
      },
      rates: {
        flatrate: [{
          code: 'flatrate_flatrate',
          carrier: 'flatrate',
          carrier_title: 'Flat Rate',
          method: 'flatrate',
          method_title: 'Fixed',
          price: 7,
          selected: true,
        }],
      },
      items: { 2: 1 },
    },
  };

  currentShippingData = {
    method: { carrier_code: 'composite', method_code: 'composite' },
    sourceRates: mockSourceRates,
  };

  if (currentCartData && cartListElement) {
    transformCartToShipments(cartListElement, currentCartData, currentShippingData);
  }
}

/**
 * GraphQL mutation to get estimate shipping with additional_data
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
 * Fetch shipping estimate with additional_data (raw GraphQL call)
 * @param {string} cartId - Cart ID
 * @param {Object} address - Address input from shipping/estimate event
 * @returns {Promise<Array>} Shipping methods array
 */
async function fetchShippingEstimateRaw(cartId, address) {
  try {
    const { CORE_FETCH_GRAPHQL } = await import('../../commerce.js');

    // Build address input - handle different formats from the event
    const addressInput = {
      country_code: address.countryCode || address.country_code || 'US',
      postcode: address.postCode || address.postcode || '',
    };

    // Add region if present
    if (address.region) {
      addressInput.region = {
        region: address.region.region || address.region || '',
      };
      if (address.region.id || address.regionId) {
        addressInput.region.region_id = address.region.id || address.regionId;
      }
    }

    const response = await CORE_FETCH_GRAPHQL.fetchGraphQl(ESTIMATE_SHIPPING_MUTATION, {
      variables: {
        cartId,
        address: addressInput,
      },
    });

    if (response?.errors) {
      // eslint-disable-next-line no-console
      console.error('[CartShipments] GraphQL errors:', response.errors);
      return null;
    }

    return response?.data?.estimateShippingMethods || null;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[CartShipments] Failed to fetch shipping estimate:', error);
    return null;
  }
}

/**
 * Initialize cart shipments functionality
 * @param {HTMLElement} cartList - The .cart__list element
 */
export function initCartShipments(cartList) {
  cartListElement = cartList;

  // Listen for cart data updates
  events.on('cart/data', (cartData) => {
    currentCartData = cartData;

    // If we have shipping data, transform cart into shipments
    if (currentShippingData && cartData?.items?.length > 0) {
      transformCartToShipments(cartList, cartData, currentShippingData);
    }
  }, { eager: true });

  // Listen for shipping estimate events from the dropin
  // When user submits estimate, we make our own call to get additional_data
  events.on('shipping/estimate', async (data) => {
    if (!data?.address) {
      return;
    }

    // Get cart ID
    const Cart = await import('@dropins/storefront-cart/api.js');
    const cartData = Cart.getCartDataFromCache();

    if (!cartData?.id) {
      return;
    }

    // Fetch raw shipping estimate with additional_data
    const shippingMethods = await fetchShippingEstimateRaw(cartData.id, data.address);

    if (shippingMethods) {
      lastRawShippingResponse = shippingMethods;
      handleShippingEstimateResponse(shippingMethods);
    }
  });
}

/**
 * Build new shipments UI off-DOM and swap it in atomically (no flash)
 * @param {HTMLElement} cartList - The .cart__list element
 * @param {Object} cartData - Cart data from the API
 * @param {Object} shippingData - Parsed composite shipping data
 */
function rebuildShipmentsUI(cartList, cartData, shippingData) {
  if (!cartData?.items?.length || !shippingData?.sourceRates) {
    return;
  }

  const { sourceRates } = shippingData;
  const shipments = groupItemsBySourceRates(cartData.items, sourceRates);
  const totalShipments = shipments.size;

  if (totalShipments < 2) {
    removeShipmentUI(cartList);
    return;
  }

  const cartSummaryList = cartList.querySelector('.cart-cart-summary-list');
  const cartListEl = cartList.querySelector('[data-testid="cart-list"]');

  if (!cartSummaryList || !cartListEl || cartListEl.children.length === 0) {
    return;
  }

  // Build a map from quoteItemId to { element, cartItem }
  const quoteIdToData = new Map();
  cartData.items.forEach((item) => {
    const quoteItemId = decodeCartItemUid(item.uid);
    const element = cartListEl.querySelector(`[data-testid="cart-list-item-entry-${item.uid}"]`);
    if (element) {
      quoteIdToData.set(quoteItemId, { element, cartItem: item });
    }
  });

  // Build new shipments container completely off-DOM
  const newShipmentsContainer = document.createElement('div');
  newShipmentsContainer.className = 'shipments-container';

  let shipmentIndex = 1;
  shipments.forEach((shipmentData, sourceCode) => {
    const shipmentContainer = createShipmentContainer(
      shipmentIndex,
      totalShipments,
      sourceCode,
      shipmentData,
    );
    const itemsList = shipmentContainer.querySelector('.shipment-items__list');

    // Clone and add items to this shipment
    shipmentData.items.forEach(({ cartItem, sourceQty, originalQty }) => {
      const quoteItemId = decodeCartItemUid(cartItem.uid);
      const itemData = quoteIdToData.get(quoteItemId);

      if (itemData) {
        const clonedElement = itemData.element.cloneNode(true);
        const itemWrapper = document.createElement('div');
        itemWrapper.className = 'shipment-item-wrapper';
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

  // Now do a single atomic DOM swap
  const existingContainer = cartList.querySelector('.shipments-container');
  if (existingContainer) {
    // Replace existing container with new one (single DOM operation)
    existingContainer.replaceWith(newShipmentsContainer);
  } else {
    // First time - hide original content and append
    const heading = cartSummaryList.querySelector('.cart-cart-summary-list__heading');
    if (heading) {
      heading.style.display = 'none';
    }

    const content = cartSummaryList.querySelector('.cart-cart-summary-list__content');
    if (content) {
      content.style.display = 'none';
    }

    cartSummaryList.appendChild(newShipmentsContainer);
  }
}

/**
 * Handle shipping estimate response
 * @param {Array} shippingMethods - Array of shipping methods
 */
function handleShippingEstimateResponse(shippingMethods) {
  const compositeData = getCompositeShippingData(shippingMethods);

  if (compositeData) {
    currentShippingData = compositeData;

    // Transform cart if we have cart data
    if (currentCartData?.items?.length > 0 && cartListElement) {
      // Small delay to let any other UI updates complete
      setTimeout(() => {
        // Build new UI and swap in a single operation (no flash)
        rebuildShipmentsUI(cartListElement, currentCartData, compositeData);
      }, 100);
    }
  } else {
    // No composite shipping - remove any existing shipment UI
    currentShippingData = null;
    if (cartListElement) {
      removeShipmentUI(cartListElement);
    }
  }
}

export default {
  initCartShipments,
  transformCartToShipments,
  getCompositeShippingData,
  groupItemsBySourceRates,
};
