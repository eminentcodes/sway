// lib/somnia/abi.ts — the one event we decode ourselves for discovery.
//
// We inline the MarketCreator's `MarketCreated` signature (13 fields) rather than
// deep-importing it from the SDK's dist. The SDK's package `exports` map does NOT
// expose `./dist/eventsAbi.js`, so a bare-specifier deep import throws
// ERR_PACKAGE_PATH_NOT_EXPORTED under Node ESM. Owning the tiny ABI is more robust
// and self-documenting. Signature verified against markets-sdk dist/eventsAbi.js
// (marketCreatorEventsAbi) at v0.29.0.

export const marketCreatedEvent = {
  type: "event",
  name: "MarketCreated",
  inputs: [
    { name: "marketId", type: "bytes32", indexed: true },
    { name: "market", type: "address", indexed: true },
    { name: "pool", type: "address", indexed: true },
    { name: "yesId", type: "uint256", indexed: false },
    { name: "noId", type: "uint256", indexed: false },
    { name: "collateral", type: "address", indexed: false },
    { name: "asset", type: "string", indexed: false },
    { name: "strike", type: "uint256", indexed: false },
    { name: "tradingStart", type: "uint64", indexed: false },
    { name: "expiry", type: "uint64", indexed: false },
    { name: "oracleQuestionId", type: "uint256", indexed: false },
    { name: "question", type: "string", indexed: false },
    { name: "intervalSec", type: "uint64", indexed: false },
  ],
  anonymous: false,
} as const;
