# Cart Shipments Component

Multi-Source Inventory (MSI) shipping UI for AEM Edge Delivery Services commerce projects.

## Overview

This module extends the Adobe Storefront Cart dropin to display cart items grouped by fulfillment source (warehouse), with per-source delivery options. It's designed for commerce implementations using Multi-Source Inventory where items may ship from different warehouses.

## Features

- Groups cart items by source/warehouse
- Displays per-source delivery options
- Handles split shipments (same item from multiple sources)
- Persists shipping address to sessionStorage
- Auto-populates shipping address via browser geolocation
- Atomic UI updates to prevent visual flashing
- Integrates with Adobe Storefront Cart dropin events

## Installation

### As part of AEM Boilerplate Commerce

The component is included in the `scripts/components/cart-shipments/` directory.

```javascript
import { initCartShipments } from './scripts/components/cart-shipments/cart-shipments.js';

// Initialize with the cart list element
const cartList = document.querySelector('.cart__list');
initCartShipments(cartList);
```

### As an npm Package (Distribution)

To distribute this as a standalone npm package:

#### 1. Create package.json

```json
{
  "name": "@your-org/aem-cart-shipments",
  "version": "1.0.0",
  "description": "MSI shipping UI for AEM Edge Delivery Services commerce",
  "type": "module",
  "main": "cart-shipments.js",
  "exports": {
    ".": {
      "import": "./cart-shipments.js"
    },
    "./styles": "./cart-shipments.css"
  },
  "files": [
    "cart-shipments.js",
    "cart-shipments.css",
    "README.md"
  ],
  "peerDependencies": {
    "@dropins/tools": ">=1.5.0",
    "@dropins/storefront-cart": ">=1.5.0"
  },
  "keywords": [
    "aem",
    "adobe",
    "commerce",
    "msi",
    "shipping",
    "cart"
  ],
  "author": "Your Name",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/your-org/aem-cart-shipments.git"
  }
}
```

#### 2. Publish to npm

```bash
# Login to npm (or your private registry)
npm login

# Publish the package
npm publish --access public
```

#### 3. Install in other projects

```bash
npm install @your-org/aem-cart-shipments
```

```javascript
import { initCartShipments } from '@your-org/aem-cart-shipments';
import '@your-org/aem-cart-shipments/styles';
```

## Configuration

### Google API Key for Geolocation

Add your Google Geocoding API key to `config.json`:

```json
{
  "public": {
    "default": {
      "google-api-key": "YOUR_API_KEY_HERE"
    }
  }
}
```

### Backend Requirements

This component requires a Magento/Adobe Commerce backend with:

1. **Multi-Source Inventory (MSI)** enabled
2. **Composite Shipping Carrier** that returns `source_rates` in `additional_data`
3. **Custom cart attribute** support for `ext_shipping_info`

## API

### initCartShipments(cartList)

Initialize the cart shipments functionality.

```javascript
initCartShipments(document.querySelector('.cart__list'));
```

### Events

The module listens to and emits the following events:

**Listens to:**
- `cart/data` - Cart data updates from the dropin
- `shipping/estimate` - Shipping estimate submissions

**Emits:**
- `shipping/estimate` - When refreshing shipping after source selection changes

## CSS Classes

The component uses BEM-style class names:

- `.shipments-container` - Main container
- `.shipment-container` - Individual shipment group
- `.shipment-header` - Shipment header (title, location)
- `.shipment-items` - Items table
- `.shipment-delivery-options` - Delivery options form
- `.shipment-item-wrapper` - Item row wrapper
- `.shipment-item-split-note` - "(of X)" note for split items

## Testing

### Unit Tests

```bash
# Install vitest
npm install -D vitest

# Run tests
npx vitest run scripts/components/cart-shipments/test/cart-shipments.test.js
```

### Browser Testing

Use Cypress or Playwright for full integration testing:

```javascript
// cypress/e2e/cart-shipments.cy.js
describe('Cart Shipments', () => {
  it('displays multiple shipments when MSI is active', () => {
    cy.visit('/cart');
    cy.get('.shipment-container').should('have.length.at.least', 2);
  });
});
```

## Browser Support

- Chrome 90+
- Firefox 90+
- Safari 14+
- Edge 90+

## License

Apache-2.0
