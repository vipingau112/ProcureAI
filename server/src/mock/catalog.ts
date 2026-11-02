import type { CatalogProduct } from '../types';

/** Mirrors the shape we normalize Channel3 results into: one product, many merchant offers. */
const offer = (domain: string, price: number, availability = 'InStock') => ({
  domain,
  url: `https://${domain}/mock-product`,
  price,
  currency: 'USD',
  availability,
});

export const MOCK_PRODUCTS: (CatalogProduct & { keywords: string[] })[] = [
  { id: 'm-paper-1', title: 'Hammermill Copy Plus Paper, 8.5x11, 20 lb, 500 sheets', brand: 'Hammermill', keywords: ['copy', 'paper', 'sheets', 'letter', 'printer'], offers: [offer('staples.com', 7.99), offer('officedepot.com', 7.49), offer('amazon.com', 8.29)] },
  { id: 'm-paper-2', title: 'Amazon Basics Multipurpose Copy Paper, 500 sheets', brand: 'Amazon Basics', keywords: ['copy', 'paper', 'sheets', 'letter', 'printer'], offers: [offer('amazon.com', 6.89), offer('walmart.com', 7.19, 'OutOfStock')] },
  { id: 'm-marker-1', title: 'EXPO Low-Odor Dry Erase Markers, Chisel Tip, 12 Count', brand: 'EXPO', keywords: ['dry', 'erase', 'markers', 'whiteboard', '12', 'pack'], offers: [offer('staples.com', 13.49), offer('officedepot.com', 12.79), offer('amazon.com', 12.19)] },
  { id: 'm-marker-2', title: 'Crayola Washable Dry Erase Markers, 12 Pack', brand: 'Crayola', keywords: ['dry', 'erase', 'markers', 'whiteboard', '12', 'pack'], offers: [offer('walmart.com', 9.97), offer('target.com', 10.49)] },
  { id: 'm-usbc-1', title: 'Anker USB-C to USB-C Cable, 6 ft, 100W', brand: 'Anker', keywords: ['usb-c', 'usb', 'cable', '6ft', 'charging'], offers: [offer('anker.com', 11.99), offer('amazon.com', 10.99), offer('bestbuy.com', 12.99)] },
  { id: 'm-usbc-2', title: 'Belkin BoostCharge USB-C Cable, 6 ft', brand: 'Belkin', keywords: ['usb-c', 'usb', 'cable', '6ft', 'charging'], offers: [offer('belkin.com', 17.99), offer('amazon.com', 15.99)] },
  { id: 'm-lamp-1', title: 'LED Desk Lamp with Wireless Charger, Dimmable', brand: 'Generic', keywords: ['led', 'desk', 'lamp', 'light'], offers: [offer('amazon.com', 29.99), offer('walmart.com', 32.5), offer('target.com', 34.99)] },
  { id: 'm-lamp-2', title: 'TaoTronics LED Desk Lamp, 5 Color Modes', brand: 'TaoTronics', keywords: ['led', 'desk', 'lamp', 'light'], offers: [offer('amazon.com', 26.99), offer('bestbuy.com', 31.99)] },
  { id: 'm-mouse-1', title: 'Logitech M330 Silent Plus Wireless Mouse', brand: 'Logitech', keywords: ['wireless', 'mouse', 'silent'], offers: [offer('amazon.com', 17.99), offer('bestbuy.com', 19.99), offer('staples.com', 19.49)] },
  { id: 'm-coffee-1', title: 'Lavazza Super Crema Whole Bean Coffee, 1 kg', brand: 'Lavazza', keywords: ['whole', 'bean', 'coffee', '1kg', 'espresso'], offers: [offer('amazon.com', 19.99), offer('walmart.com', 18.97), offer('target.com', 21.49)] },
  { id: 'm-coffee-2', title: "Peet's Major Dickason's Blend Whole Bean, 2 lb", brand: "Peet's", keywords: ['whole', 'bean', 'coffee', 'dark', 'roast'], offers: [offer('peets.com', 24.95), offer('amazon.com', 22.99)] },
];
