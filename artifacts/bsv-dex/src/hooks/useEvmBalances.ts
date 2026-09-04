import { useEffect, useState, useCallback } from "react";
import { CHAIN_RPC_URLS, CHAIN_RPC_FALLBACKS, getWagmiConfig } from "@/lib/reown";
import { useCustomTokenStore, type CustomToken } from "@/store/useCustomTokenStore";
import { useCustomChainStore } from "@/store/useCustomChainStore";

export interface TokenBalance {
  symbol: string;
  name: string;
  amount: number;
  usdValue: number;
  price: number;
  change24h: number;
  color: string;
  decimals: number;
  isNative?: boolean;
  contractAddress?: string;
  isCustom?: boolean;
}

// ERC-20 token registry per chainId
export const ERC20_TOKENS: Record<number, Array<{ symbol: string; name: string; address: string; decimals: number; color: string }>> = {
  1: [ // Ethereum Mainnet
    { symbol: "USDT",  name: "Tether USD",         address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6,  color: "#22C55E" },
    { symbol: "USDC",  name: "USD Coin",            address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6,  color: "#3B82F6" },
    { symbol: "WBTC",  name: "Wrapped BTC",         address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8,  color: "#F97316" },
    { symbol: "DAI",   name: "Dai Stablecoin",      address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, color: "#EAB308" },
    { symbol: "WETH",  name: "Wrapped Ether",       address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, color: "#8B5CF6" },
    { symbol: "LINK",  name: "Chainlink",           address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18, color: "#3B82F6" },
    { symbol: "UNI",   name: "Uniswap",             address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18, color: "#FF007A" },
    { symbol: "AAVE",  name: "Aave",                address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", decimals: 18, color: "#B6509E" },
    { symbol: "LDO",   name: "Lido DAO",            address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", decimals: 18, color: "#00A3FF" },
    { symbol: "CRV",   name: "Curve DAO",           address: "0xD533a949740bb3306d119CC777fa900bA034cd52", decimals: 18, color: "#EAB308" },
    { symbol: "MKR",   name: "Maker",               address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", decimals: 18, color: "#1AAB9B" },
    { symbol: "SNX",   name: "Synthetix",           address: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F", decimals: 18, color: "#00D1FF" },
    { symbol: "COMP",  name: "Compound",            address: "0xc00e94Cb662C3520282E6f5717214004A7f26888", decimals: 18, color: "#00D395" },
    { symbol: "GRT",   name: "The Graph",           address: "0xc944E90C64B2c07662A292be6244BDf05Cda44a7", decimals: 18, color: "#6747ED" },
    { symbol: "ENS",   name: "Ethereum Name Service", address: "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72", decimals: 18, color: "#5298FF" },
    { symbol: "RNDR",  name: "Render Token",        address: "0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24", decimals: 18, color: "#FF4500" },
    { symbol: "FET",   name: "Fetch.ai",            address: "0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85", decimals: 18, color: "#3B82F6" },
    { symbol: "IMX",   name: "Immutable X",         address: "0xF57e7e7C23978C3cAEC3C3548E3D615c346e79fF", decimals: 18, color: "#00BFFF" },
    { symbol: "MATIC", name: "Polygon",             address: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0", decimals: 18, color: "#8247E5" },
    { symbol: "SHIB",  name: "Shiba Inu",           address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", decimals: 18, color: "#FF0000" },
    { symbol: "PEPE",  name: "Pepe",                address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", decimals: 18, color: "#00B140" },
    { symbol: "SAND",  name: "The Sandbox",         address: "0x3845badAde8e6dFF049820680d1F14bD3903a5d0", decimals: 18, color: "#00ADEF" },
    { symbol: "MANA",  name: "Decentraland",        address: "0x0F5D2fB29fb7d3CFeE444a200298f468908cC942", decimals: 18, color: "#FF2D55" },
    { symbol: "AXS",   name: "Axie Infinity",       address: "0xBB0E17EF65F82Ab018d8EDd776e8DD940327B28b", decimals: 18, color: "#0055D5" },
    { symbol: "OCEAN", name: "Ocean Protocol",      address: "0x967da4048cD07aB37855c090aAF366e4ce1b9F48", decimals: 18, color: "#141414" },
    { symbol: "YFI",   name: "yearn.finance",       address: "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e", decimals: 18, color: "#0066FF" },
    { symbol: "BAL",   name: "Balancer",            address: "0xba100000625a3754423978a60c9317c58a424e3D", decimals: 18, color: "#1E1E1E" },
    { symbol: "SUSHI", name: "SushiSwap",           address: "0x6B3595068778DD592e39A122f4f5a5cF09C90fE2", decimals: 18, color: "#FA52A0" },
    { symbol: "1INCH", name: "1inch",               address: "0x111111111117dC0aa78b770fA6A738034120C302", decimals: 18, color: "#1B314F" },
    { symbol: "DYDX",  name: "dYdX",                address: "0x92D6C1e31e14520e676a687F0a93788B716BEff5", decimals: 18, color: "#6966FF" },
    { symbol: "RPL",   name: "Rocket Pool",         address: "0xD33526068D116cE69F19A9ee46F0bd304F21A51f", decimals: 18, color: "#FF6B00" },
    { symbol: "PENDLE",name: "Pendle",              address: "0x808507121B80c02388fAd14726482e061B8da827", decimals: 18, color: "#3ABAB4" },
    { symbol: "ONDO",  name: "Ondo Finance",        address: "0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3", decimals: 18, color: "#1E40AF" },
    { symbol: "LPT",   name: "Livepeer",            address: "0x58b6A8A3302369DAEc383334672404Ee733aB239", decimals: 18, color: "#00EB88" },
    { symbol: "REN",   name: "Ren",                 address: "0x408e41876cCCDC0F92210600ef50372656052a38", decimals: 18, color: "#001C3D" },
    { symbol: "stETH", name: "Lido Staked ETH",     address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", decimals: 18, color: "#00A3FF" },
    { symbol: "rETH",  name: "Rocket Pool ETH",     address: "0xae78736Cd615f374D3085123A210448E74Fc6393", decimals: 18, color: "#FF6B00" },
    { symbol: "FRAX",  name: "Frax",                address: "0x853d955aCEf822Db058eb8505911ED77F175b99e", decimals: 18, color: "#000000" },
    { symbol: "FXS",   name: "Frax Share",          address: "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0", decimals: 18, color: "#000000" },
    { symbol: "CVX",   name: "Convex Finance",      address: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B", decimals: 18, color: "#3A3A3A" },
    { symbol: "FLR",   name: "Flare",               address: "0xE61F9b563C8fF5a0B3fC5E8eAfB5FBfeeBDf20F9", decimals: 18, color: "#E84142" },
  ],
  56: [ // BNB Chain
    { symbol: "USDT",  name: "Tether USD",          address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, color: "#22C55E" },
    { symbol: "USDC",  name: "USD Coin",             address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, color: "#3B82F6" },
    { symbol: "DAI",   name: "Dai Stablecoin",       address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", decimals: 18, color: "#EAB308" },
    { symbol: "BUSD",  name: "Binance USD",          address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", decimals: 18, color: "#F0B90B" },
    { symbol: "CAKE",  name: "PancakeSwap",          address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", decimals: 18, color: "#633001" },
    { symbol: "WBTC",  name: "Wrapped BTC",          address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", decimals: 18, color: "#F97316" },
    { symbol: "ETH",   name: "Ethereum (BEP-20)",    address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", decimals: 18, color: "#8B5CF6" },
    { symbol: "XRP",   name: "XRP Token",            address: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE", decimals: 18, color: "#00AAE4" },
    { symbol: "ADA",   name: "Cardano Token",        address: "0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47", decimals: 18, color: "#0033AD" },
    { symbol: "DOT",   name: "Polkadot Token",       address: "0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402", decimals: 18, color: "#E6007A" },
    { symbol: "LINK",  name: "Chainlink",            address: "0xF8A0BF9cFF54Bb92F17374d9e9A321E6a111a51bD", decimals: 18, color: "#3B82F6" },
    { symbol: "UNI",   name: "Uniswap",              address: "0xBf5140A22578168FD562DCcF235E5D43A02ce9B1", decimals: 18, color: "#FF007A" },
    { symbol: "AVAX",  name: "Avalanche Token",      address: "0x1CE0c2827e2eF14D5C4f29a091d735A204794041", decimals: 18, color: "#E84142" },
    { symbol: "MATIC", name: "Polygon Token",        address: "0xCC42724C6683B7E57334c4E856f4c9965ED682bD", decimals: 18, color: "#8247E5" },
    { symbol: "DOGE",  name: "Dogecoin Token",       address: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43", decimals: 8,  color: "#C2A633" },
    { symbol: "SHIB",  name: "Shiba Inu",            address: "0x2859e4544C4bB03966803b044A93563Bd2D0DD4D", decimals: 18, color: "#FF0000" },
    { symbol: "PEPE",  name: "Pepe",                 address: "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00", decimals: 18, color: "#00B140" },
    { symbol: "INJ",   name: "Injective",            address: "0xa2B726B1145A4773F68593CF171187d8EBe4d495", decimals: 18, color: "#0082FA" },
    { symbol: "SOL",   name: "Solana Token",         address: "0x570A5D26f7765Ecb712C0924E4De545B89fD43dF", decimals: 18, color: "#9945FF" },
    { symbol: "TON",   name: "Toncoin",              address: "0x76A797A59Ba2C17726896976B7B3747BfD1d220f", decimals: 9,  color: "#0088CC" },
    { symbol: "LTC",   name: "Litecoin Token",       address: "0x4338665CBB7B2485A8855A139b75D5e34AB0DB94", decimals: 18, color: "#A0A0A0" },
    { symbol: "BCH",   name: "Bitcoin Cash Token",   address: "0x8fF795a6F4D97E7887C79beA79aba5cc76444aDf", decimals: 18, color: "#8DC351" },
    { symbol: "NEAR",  name: "NEAR Protocol",        address: "0x1Fa4a73a3F0133f0025378af00236f3aBDEE5D63", decimals: 18, color: "#00C08B" },
    { symbol: "FIL",   name: "Filecoin",             address: "0x0D8Ce2A99Bb6e3B7Db580eD848240e4a0F9aE153", decimals: 18, color: "#0090FF" },
  ],
  137: [ // Polygon
    { symbol: "USDT",  name: "Tether USD",           address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6,  color: "#22C55E" },
    { symbol: "USDC",  name: "USD Coin (PoS)",        address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6,  color: "#3B82F6" },
    { symbol: "USDC.e",name: "USD Coin (Bridged)",    address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6,  color: "#3B82F6" },
    { symbol: "DAI",   name: "Dai Stablecoin",        address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18, color: "#EAB308" },
    { symbol: "WBTC",  name: "Wrapped BTC",           address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8,  color: "#F97316" },
    { symbol: "WETH",  name: "Wrapped Ether",         address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, color: "#8B5CF6" },
    { symbol: "LINK",  name: "Chainlink",             address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18, color: "#3B82F6" },
    { symbol: "AAVE",  name: "Aave",                  address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, color: "#B6509E" },
    { symbol: "CRV",   name: "Curve DAO",             address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18, color: "#EAB308" },
    { symbol: "UNI",   name: "Uniswap",               address: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f", decimals: 18, color: "#FF007A" },
    { symbol: "SAND",  name: "The Sandbox",           address: "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683", decimals: 18, color: "#00ADEF" },
    { symbol: "MANA",  name: "Decentraland",          address: "0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4", decimals: 18, color: "#FF2D55" },
    { symbol: "GRT",   name: "The Graph",             address: "0x5fe2B58c013d7601147DcdD68C143A77499f5531", decimals: 18, color: "#6747ED" },
    { symbol: "QUICK", name: "QuickSwap",             address: "0x831753DD7087CaC61aB5644b308642cc1c33Dc13", decimals: 18, color: "#4DCCE1" },
    { symbol: "stMATIC",name:"Lido Staked MATIC",     address: "0x3A58a54C066FdC0f2D55FC9C89F0415C92eBf3C", decimals: 18, color: "#00A3FF" },
    { symbol: "WBTC",  name: "Wrapped BTC",           address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8,  color: "#F97316" },
    { symbol: "FRAX",  name: "Frax",                  address: "0x45c32fA6DF82ead1e2EF74d17b76547EDdFaFF89", decimals: 18, color: "#000000" },
    { symbol: "agEUR", name: "Angle Euro",            address: "0xE0B52e49357Fd4DAf2c15e02058DCE6BC0057db4", decimals: 18, color: "#4CAF50" },
  ],
  42161: [ // Arbitrum One
    { symbol: "USDT",  name: "Tether USD",            address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6,  color: "#22C55E" },
    { symbol: "USDC",  name: "USD Coin",              address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", decimals: 6,  color: "#3B82F6" },
    { symbol: "USDC.e",name: "USD Coin (Bridged)",    address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", decimals: 6,  color: "#3B82F6" },
    { symbol: "WBTC",  name: "Wrapped BTC",           address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8,  color: "#F97316" },
    { symbol: "DAI",   name: "Dai Stablecoin",        address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, color: "#EAB308" },
    { symbol: "WETH",  name: "Wrapped Ether",         address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, color: "#8B5CF6" },
    { symbol: "LINK",  name: "Chainlink",             address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", decimals: 18, color: "#3B82F6" },
    { symbol: "ARB",   name: "Arbitrum",              address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, color: "#28A0F0" },
    { symbol: "GMX",   name: "GMX",                   address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", decimals: 18, color: "#00B0FF" },
    { symbol: "MAGIC", name: "Magic",                 address: "0x539bdE0d7Dbd336b79148AA742883198BBF60342", decimals: 18, color: "#DC2626" },
    { symbol: "GRT",   name: "The Graph",             address: "0x9623063377AD1B27544C965cCd7342f7EA7e88C7", decimals: 18, color: "#6747ED" },
    { symbol: "UNI",   name: "Uniswap",               address: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0", decimals: 18, color: "#FF007A" },
    { symbol: "PENDLE",name: "Pendle",                address: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8", decimals: 18, color: "#3ABAB4" },
    { symbol: "RDNT",  name: "Radiant Capital",       address: "0x3082CC23568eA640225c2467653dB90e9250AaA0", decimals: 18, color: "#FFA800" },
    { symbol: "JONES", name: "Jones DAO",             address: "0x10393c20975cF177a3513071bC110f7962CD67da", decimals: 18, color: "#00D1FF" },
    { symbol: "GNS",   name: "Gains Network",         address: "0x18c11FD286C5EC11c3b683Caa813B77f5163A122", decimals: 18, color: "#00C3FF" },
  ],
  10: [ // Optimism
    { symbol: "USDT",  name: "Tether USD",            address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6,  color: "#22C55E" },
    { symbol: "USDC",  name: "USD Coin",              address: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", decimals: 6,  color: "#3B82F6" },
    { symbol: "USDC.e",name: "USD Coin (Bridged)",    address: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", decimals: 6,  color: "#3B82F6" },
    { symbol: "DAI",   name: "Dai Stablecoin",        address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, color: "#EAB308" },
    { symbol: "WBTC",  name: "Wrapped BTC",           address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", decimals: 8,  color: "#F97316" },
    { symbol: "WETH",  name: "Wrapped Ether",         address: "0x4200000000000000000000000000000000000006", decimals: 18, color: "#8B5CF6" },
    { symbol: "OP",    name: "Optimism",              address: "0x4200000000000000000000000000000000000042", decimals: 18, color: "#FF0420" },
    { symbol: "LINK",  name: "Chainlink",             address: "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6", decimals: 18, color: "#3B82F6" },
    { symbol: "SNX",   name: "Synthetix",             address: "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4", decimals: 18, color: "#00D1FF" },
    { symbol: "AAVE",  name: "Aave",                  address: "0x76FB31fb4af56892A25e32cFC43De717950c9278", decimals: 18, color: "#B6509E" },
    { symbol: "UNI",   name: "Uniswap",               address: "0x6fd9d7AD17242c41f7131d257212c54A0e816691", decimals: 18, color: "#FF007A" },
    { symbol: "AERO",  name: "Aerodrome",             address: "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db", decimals: 18, color: "#E25BFF" },
    { symbol: "VELO",  name: "Velodrome",             address: "0x3c8B650257cFb5f272f799F5e2b4e65093a11a05", decimals: 18, color: "#FF6B00" },
    { symbol: "PERP",  name: "Perpetual Protocol",    address: "0x9e1028F5F1D5eDE59748FFceE5532509976840E0", decimals: 18, color: "#00D395" },
  ],
  8453: [ // Base
    { symbol: "USDT",  name: "Tether USD",            address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6,  color: "#22C55E" },
    { symbol: "USDC",  name: "USD Coin",              address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6,  color: "#3B82F6" },
    { symbol: "USDbC", name: "USD Base Coin",         address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6,  color: "#3B82F6" },
    { symbol: "DAI",   name: "Dai Stablecoin",        address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, color: "#EAB308" },
    { symbol: "cbBTC", name: "Coinbase BTC",          address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8,  color: "#F97316" },
    { symbol: "cbETH", name: "Coinbase ETH",          address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18, color: "#8B5CF6" },
    { symbol: "WETH",  name: "Wrapped Ether",         address: "0x4200000000000000000000000000000000000006", decimals: 18, color: "#8B5CF6" },
    { symbol: "AERO",  name: "Aerodrome",             address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18, color: "#E25BFF" },
    { symbol: "BRETT", name: "Brett",                 address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", decimals: 18, color: "#1E90FF" },
    { symbol: "TOSHI", name: "Toshi",                 address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", decimals: 18, color: "#F59E0B" },
    { symbol: "DEGEN", name: "Degen",                 address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", decimals: 18, color: "#A855F7" },
    { symbol: "HIGHER",name: "Higher",                address: "0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe", decimals: 18, color: "#22C55E" },
    { symbol: "NORMIE",name: "Normie",                address: "0x7F12d13B34F5F4f0a9449c89bCE986DC2d4d6d72", decimals: 9,  color: "#F97316" },
    { symbol: "BALD",  name: "Bald",                  address: "0x27D2DECb4bFC9C76F0309b8E88dec3a601Fe25a8", decimals: 18, color: "#F59E0B" },
    { symbol: "MOG",   name: "Mog Coin",              address: "0x2Da56AcB9Ea78330f947bD57C54119Debda7AF71", decimals: 18, color: "#7C3AED" },
    { symbol: "VIRTUAL",name:"Virtuals Protocol",     address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7020", decimals: 18, color: "#6366F1" },
    { symbol: "SEAM",  name: "Seamless",              address: "0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85", decimals: 18, color: "#00D4AA" },
    { symbol: "LINK",  name: "Chainlink",             address: "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196", decimals: 18, color: "#3B82F6" },
    { symbol: "WBTC",  name: "Wrapped BTC",           address: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", decimals: 8,  color: "#F97316" },
    { symbol: "SNX",   name: "Synthetix",             address: "0x22e6966B799c4D5B13BE962E1D117b56327FDa66", decimals: 18, color: "#00D1FF" },
  ],
  43114: [ // Avalanche C-Chain
    { symbol: "USDT",  name: "Tether USD",            address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6,  color: "#22C55E" },
    { symbol: "USDC",  name: "USD Coin",              address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6,  color: "#3B82F6" },
    { symbol: "DAI",   name: "Dai Stablecoin",        address: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70", decimals: 18, color: "#EAB308" },
    { symbol: "WBTC",  name: "Wrapped BTC",           address: "0x50b7545627a5162F82A992c33b87aDc75187B218", decimals: 8,  color: "#F97316" },
    { symbol: "WETH",  name: "Wrapped Ether",         address: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", decimals: 18, color: "#8B5CF6" },
    { symbol: "JOE",   name: "Trader Joe",            address: "0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd", decimals: 18, color: "#E05C2E" },
    { symbol: "LINK",  name: "Chainlink",             address: "0x5947BB275c521040051D82396192181b413227A3", decimals: 18, color: "#3B82F6" },
    { symbol: "AAVE",  name: "Aave",                  address: "0x63a72806098Bd3D9520cC43356dD78afe5D386D9", decimals: 18, color: "#B6509E" },
    { symbol: "QI",    name: "BENQI",                 address: "0x8729438EB15e2C8B576fCc6AeCdA6A148776C0F5", decimals: 18, color: "#00D395" },
    { symbol: "PNG",   name: "Pangolin",              address: "0x60781C2586D68229fde47564546784ab3fACA982", decimals: 18, color: "#FC8E00" },
  ],
  59144: [ // Linea
    { symbol: "USDT",  name: "Tether USD",            address: "0xA219439258ca9da29E9Cc4cE5596924745e12B93", decimals: 6,  color: "#22C55E" },
    { symbol: "USDC",  name: "USD Coin",              address: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", decimals: 6,  color: "#3B82F6" },
    { symbol: "DAI",   name: "Dai Stablecoin",        address: "0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d8", decimals: 18, color: "#EAB308" },
    { symbol: "WBTC",  name: "Wrapped BTC",           address: "0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4", decimals: 8,  color: "#F97316" },
    { symbol: "WETH",  name: "Wrapped Ether",         address: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34e", decimals: 18, color: "#8B5CF6" },
  ],
  534352: [ // Scroll
    { symbol: "USDC",  name: "USD Coin",              address: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", decimals: 6,  color: "#3B82F6" },
    { symbol: "USDT",  name: "Tether USD",            address: "0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df", decimals: 6,  color: "#22C55E" },
    { symbol: "DAI",   name: "Dai Stablecoin",        address: "0xcA77eB3fEFe3725Dc33bccB54eDEFc3D9f764f97", decimals: 18, color: "#EAB308" },
    { symbol: "WBTC",  name: "Wrapped BTC",           address: "0x3C1BCa5a656e69edCD0D4E36BEbb3FcDAcA60Cf1", decimals: 8,  color: "#F97316" },
    { symbol: "WETH",  name: "Wrapped Ether",         address: "0x5300000000000000000000000000000000000004", decimals: 18, color: "#8B5CF6" },
  ],
  5000: [ // Mantle
    { symbol: "USDT",  name: "Tether USD",            address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE", decimals: 6,  color: "#22C55E" },
    { symbol: "USDC",  name: "USD Coin",              address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", decimals: 6,  color: "#3B82F6" },
    { symbol: "WBTC",  name: "Wrapped BTC",           address: "0xCAbAE6f6Ea1ecaB08Ad02fE02ce9A44F09aebfA2", decimals: 8,  color: "#F97316" },
    { symbol: "WETH",  name: "Wrapped Ether",         address: "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111", decimals: 18, color: "#8B5CF6" },
  ],
  324: [ // zkSync Era
    { symbol: "USDC",  name: "USD Coin",              address: "0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4", decimals: 6,  color: "#3B82F6" },
    { symbol: "USDT",  name: "Tether USD",            address: "0x493257fD37EDB34451f62EDf8D2a0C418852bA4C", decimals: 6,  color: "#22C55E" },
    { symbol: "WBTC",  name: "Wrapped BTC",           address: "0xBBeB516fb02a01611cBBE0453Fe3c580D7281011", decimals: 8,  color: "#F97316" },
    { symbol: "WETH",  name: "Wrapped Ether",         address: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91", decimals: 18, color: "#8B5CF6" },
  ],
  250: [ // Fantom
    { symbol: "USDT",  name: "Tether USD",            address: "0x049d68029688eAbF473097a2fC38ef61633A3C7A", decimals: 6,  color: "#22C55E" },
    { symbol: "USDC",  name: "USD Coin",              address: "0x04068DA6C83AFCFA0e13ba15A6696662335D5B75", decimals: 6,  color: "#3B82F6" },
    { symbol: "WBTC",  name: "Wrapped BTC",           address: "0x321162Cd933E2Be498Cd2267a90534A804051b11", decimals: 8,  color: "#F97316" },
    { symbol: "WETH",  name: "Wrapped Ether",         address: "0x74b23882a30290451A17c44f4F05243b6b58C76d", decimals: 18, color: "#8B5CF6" },
    { symbol: "LINK",  name: "Chainlink",             address: "0xb3654dc3D10Ea7645f8319668E8F54d2574FBdC8", decimals: 18, color: "#3B82F6" },
  ],
  25: [ // Cronos
    { symbol: "USDT",  name: "Tether USD",            address: "0x66e428c3f67a68878562e79A0234c1F83c208770", decimals: 6,  color: "#22C55E" },
    { symbol: "USDC",  name: "USD Coin",              address: "0xc21223249CA28397B4B6541dfFaEcC539BfF0c59", decimals: 6,  color: "#3B82F6" },
    { symbol: "WBTC",  name: "Wrapped BTC",           address: "0x062E66477Faf219F25D27dCED647BF57C3107d52", decimals: 8,  color: "#F97316" },
    { symbol: "WETH",  name: "Wrapped Ether",         address: "0xe44Fd7fCb2b1581822D0c862B68222998a0c299a", decimals: 18, color: "#8B5CF6" },
  ],
};

const NATIVE_TOKENS: Record<number, { symbol: string; name: string; color: string; cgId: string }> = {
  1:      { symbol: "ETH",  name: "Ethereum",      color: "#8B5CF6", cgId: "ethereum" },
  56:     { symbol: "BNB",  name: "BNB",            color: "#EAB308", cgId: "binancecoin" },
  137:    { symbol: "POL",  name: "Polygon",        color: "#7C3AED", cgId: "matic-network" },
  42161:  { symbol: "ETH",  name: "Ethereum",       color: "#8B5CF6", cgId: "ethereum" },
  10:     { symbol: "ETH",  name: "Ethereum",       color: "#8B5CF6", cgId: "ethereum" },
  8453:   { symbol: "ETH",  name: "Ethereum",       color: "#8B5CF6", cgId: "ethereum" },
  324:    { symbol: "ETH",  name: "Ethereum",       color: "#8B5CF6", cgId: "ethereum" },
  43114:  { symbol: "AVAX", name: "Avalanche",      color: "#E84142", cgId: "avalanche-2" },
  59144:  { symbol: "ETH",  name: "Ethereum",       color: "#8B5CF6", cgId: "ethereum" },
  534352: { symbol: "ETH",  name: "Ethereum",       color: "#8B5CF6", cgId: "ethereum" },
  5000:   { symbol: "MNT",  name: "Mantle",         color: "#00A3FF", cgId: "mantle" },
  250:    { symbol: "FTM",  name: "Fantom",         color: "#3B82F6", cgId: "fantom" },
  25:     { symbol: "CRO",  name: "Cronos",         color: "#3B82F6", cgId: "crypto-com-chain" },
  33139:  { symbol: "APE",  name: "ApeChain",       color: "#0054FA", cgId: "apecoin" },
};

const STABLECOINS = new Set(["USDT","USDC","USDbC","USDCe","USDC.e","DAI","BUSD","TUSD","USDD","FDUSD","FRAX","LUSD","USDB","GUSD","USDP","PYUSD"]);

// CoinGecko platform slugs used for contract-address price lookups
const COINGECKO_PLATFORM: Record<number, string> = {
  1:      "ethereum",
  56:     "binance-smart-chain",
  137:    "polygon-pos",
  42161:  "arbitrum-one",
  10:     "optimistic-ethereum",
  8453:   "base",
  43114:  "avalanche",
  250:    "fantom",
  324:    "zksync",
  534352: "scroll",
  59144:  "linea",
  5000:   "mantle",
  25:     "cronos",
};

const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

function balanceOfCalldata(address: string): string {
  const padded = address.toLowerCase().replace("0x", "").padStart(64, "0");
  return "0x70a08231" + padded;
}

async function rpcCall(method: string, params: any[], chainId: number): Promise<any> {
  const customRpc = useCustomChainStore.getState().getById(chainId)?.rpcUrl;
  const urls = [CHAIN_RPC_URLS[chainId], CHAIN_RPC_FALLBACKS[chainId], customRpc].filter((u): u is string => Boolean(u));
  for (const rpcUrl of urls) {
    try {
      const res = await globalThis.fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.ok) {
        const json = await res.json();
        if (!json.error && json.result !== undefined) return json.result;
      }
    } catch { /* try next */ }
  }

  const injected = (window as any).ethereum;
  if (injected) {
    try {
      const walletChainHex: string = await injected.request({ method: "eth_chainId", params: [] });
      const walletChain = parseInt(walletChainHex, 16);
      if (walletChain === chainId) {
        return await injected.request({ method, params });
      }
    } catch { /* ignore */ }
  }

  throw new Error(`No RPC available for chainId ${chainId}`);
}

/**
 * Batch JSON-RPC: send all balanceOf calls in chunked HTTP requests (max 10 per batch).
 * Falls back to individual calls if the RPC doesn't support batching.
 */
async function batchFetchBalances(
  walletAddress: string,
  tokens: Array<{ address: string; decimals: number }>,
  chainId: number,
): Promise<number[]> {
  if (tokens.length === 0) return [];

  const CHUNK = 10;
  const rpcUrls = [CHAIN_RPC_URLS[chainId], CHAIN_RPC_FALLBACKS[chainId]].filter(Boolean);

  // Split into chunks of CHUNK to avoid large-batch rejection by public RPCs
  const chunks: Array<typeof tokens> = [];
  for (let i = 0; i < tokens.length; i += CHUNK) chunks.push(tokens.slice(i, i + CHUNK));

  async function fetchChunk(chunk: typeof tokens, baseId: number): Promise<(number | null)[]> {
    const batch = chunk.map((token, j) => ({
      jsonrpc: "2.0",
      id: baseId + j,
      method: "eth_call",
      params: [{ to: token.address, data: balanceOfCalldata(walletAddress) }, "latest"],
    }));
    for (const rpcUrl of rpcUrls) {
      try {
        const res = await globalThis.fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch),
        });
        if (!res.ok) continue;
        const results: Array<{ id: number; result?: string; error?: any }> = await res.json();
        if (!Array.isArray(results)) continue;
        const byId = new Map(results.map(r => [r.id, r.result]));
        return chunk.map((token, j) => {
          const hex = byId.get(baseId + j);
          if (!hex || hex.length <= 2) return 0;
          try { return Number(BigInt(hex)) / Math.pow(10, token.decimals); }
          catch { return 0; }
        });
      } catch { /* try next rpc */ }
    }
    return new Array(chunk.length).fill(null); // signal fallback needed
  }

  // Run all chunks in parallel
  const chunkResults = await Promise.all(
    chunks.map((chunk, ci) => fetchChunk(chunk, ci * CHUNK))
  );

  // Flatten, falling back to individual rpcCall for any null entries
  const flat = chunkResults.flat();
  const fallbackNeeded = flat.some(v => v === null);
  if (!fallbackNeeded) return flat as number[];

  const individual = await Promise.allSettled(
    tokens.map(async (token, i) => {
      if (flat[i] !== null) return flat[i] as number;
      try {
        const hex = await rpcCall("eth_call", [
          { to: token.address, data: balanceOfCalldata(walletAddress) },
          "latest",
        ], chainId);
        return hex && hex.length > 2 ? Number(BigInt(hex)) / Math.pow(10, token.decimals) : 0;
      } catch { return 0; }
    })
  );
  return individual.map(r => r.status === "fulfilled" ? (r.value ?? 0) : 0);
}

export interface PriceTick { usd: number; change24h: number }

async function fetchMarketPrices(): Promise<Record<string, PriceTick>> {
  const prices: Record<string, PriceTick> = {};
  for (const sym of STABLECOINS) prices[sym] = { usd: 1, change24h: 0 };

  try {
    const res = await globalThis.fetch(`${BASE_URL}/api/prices-full`, { cache: "no-store" });
    if (res.ok) {
      const data: Record<string, { usd?: number; change24h?: number } | number> = await res.json();
      for (const [sym, val] of Object.entries(data)) {
        if (!sym) continue;
        if (typeof val === "number") {
          if (val > 0) prices[sym] = { usd: val, change24h: 0 };
        } else if (val && typeof val.usd === "number" && val.usd > 0) {
          prices[sym] = { usd: val.usd, change24h: val.change24h ?? 0 };
        }
      }
    }
  } catch { /* use hardcoded fallbacks only */ }

  const def = (sym: string, usd: number) => { if (!prices[sym]) prices[sym] = { usd, change24h: 0 }; };
  def("ETH",  2400);
  def("BNB",  580);
  def("AVAX", 18);
  def("FTM",  0.2);
  def("CRO",  0.09);
  def("MNT",  1.02);
  def("POL",  0.32);
  def("MATIC",0.32);

  return prices;
}

/**
 * For tokens with balance > 0 but no price in our feed, look them up by
 * contract address via CoinGecko's free simple/token_price API.
 * Returns a map of lowercased-address → USD price.
 */
async function fetchContractPrices(
  addresses: string[],
  chainId: number,
): Promise<Record<string, number>> {
  const platform = COINGECKO_PLATFORM[chainId];
  if (!platform || addresses.length === 0) return {};
  try {
    const addrList = addresses.join(",");
    const url = `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${addrList}&vs_currencies=usd`;
    const res = await globalThis.fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return {};
    const data: Record<string, { usd?: number }> = await res.json();
    const out: Record<string, number> = {};
    for (const [addr, val] of Object.entries(data)) {
      if (val?.usd && val.usd > 0) out[addr.toLowerCase()] = val.usd;
    }
    return out;
  } catch { return {}; }
}

/* ─── Explorer-based token scanner (Blockscout + Etherscan/Basescan) ─────── */

/**
 * Blockscout v2 API base URLs — no API key required.
 * Covers the major EVM chains.
 */
const BLOCKSCOUT_URLS: Record<number, string> = {
  1:      "https://eth.blockscout.com",
  56:     "https://bsc.blockscout.com",
  137:    "https://polygon.blockscout.com",
  42161:  "https://arbitrum.blockscout.com",
  10:     "https://optimism.blockscout.com",
  8453:   "https://base.blockscout.com",
  43114:  "https://avalanche.blockscout.com",
  59144:  "https://explorer.linea.build",
  324:    "https://zksync.blockscout.com",
  534352: "https://scroll.blockscout.com",
};

/**
 * Etherscan-compatible explorer API URLs (fallback for chains where Blockscout
 * isn't available or times out). No API key needed for basic access.
 */
const ETHERSCAN_URLS: Record<number, string> = {
  1:     "https://api.etherscan.io/api",
  8453:  "https://api.basescan.org/api",
  56:    "https://api.bscscan.com/api",
  137:   "https://api.polygonscan.com/api",
  42161: "https://api.arbiscan.io/api",
  10:    "https://api-optimistic.etherscan.io/api",
  43114: "https://api.snowtrace.io/api",
};

interface ExplorerToken {
  address: string;
  symbol:  string;
  name:    string;
  decimals: number;
  balance: number;
}

/**
 * Fetches all ERC-20 tokens held by an address using Blockscout v2 API.
 * Handles pagination automatically (up to 500 tokens).
 */
async function fetchBlockscoutTokens(
  walletAddress: string,
  chainId: number,
): Promise<ExplorerToken[]> {
  const base = BLOCKSCOUT_URLS[chainId];
  if (!base) return [];

  const results: ExplorerToken[] = [];
  let pageParams = "";

  for (let page = 0; page < 10; page++) {
    const url = `${base}/api/v2/addresses/${walletAddress}/tokens?type=ERC-20${pageParams}`;
    try {
      const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) break;
      const data = await res.json();
      if (!Array.isArray(data.items)) break;

      for (const item of data.items) {
        const tok = item.token;
        if (!tok?.address || tok.type !== "ERC-20") continue;
        const decimals = parseInt(tok.decimals ?? "18", 10) || 18;
        const rawVal = BigInt(item.value ?? "0");
        if (rawVal === 0n) continue; // skip tokens with no current balance
        const balance = Number(rawVal) / Math.pow(10, decimals);
        results.push({
          address:  tok.address.toLowerCase(),
          symbol:   (tok.symbol  ?? "???").slice(0, 20),
          name:     (tok.name    ?? tok.symbol ?? "Unknown").slice(0, 64),
          decimals,
          balance,
        });
      }

      if (!data.next_page_params) break;
      // Build query string from next_page_params
      const qs = new URLSearchParams(
        Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])
      ).toString();
      pageParams = `&${qs}`;
    } catch { break; }
  }

  return results;
}

/**
 * Fetches token transfer history from Etherscan-compatible APIs to derive
 * unique token addresses, then returns them as ExplorerToken stubs
 * (balance will be re-fetched via RPC).
 */
async function fetchEtherscanTokens(
  walletAddress: string,
  chainId: number,
): Promise<ExplorerToken[]> {
  const apiUrl = ETHERSCAN_URLS[chainId];
  if (!apiUrl) return [];

  try {
    const url = `${apiUrl}?module=account&action=tokentx&address=${walletAddress}&startblock=0&endblock=99999999&sort=desc&offset=200`;
    const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.status !== "1" || !Array.isArray(data.result)) return [];

    const seen = new Map<string, ExplorerToken>();
    for (const tx of data.result) {
      const addr = (tx.contractAddress ?? "").toLowerCase();
      if (!addr || seen.has(addr)) continue;
      const decimals = parseInt(tx.tokenDecimal ?? "18", 10) || 18;
      seen.set(addr, {
        address:  addr,
        symbol:   (tx.tokenSymbol ?? "???").slice(0, 20),
        name:     (tx.tokenName   ?? tx.tokenSymbol ?? "Unknown").slice(0, 64),
        decimals,
        balance:  0, // will be re-fetched via RPC
      });
    }
    return [...seen.values()];
  } catch { return []; }
}

/**
 * Main entry point for the "Scan tokens" button.
 * Tries Blockscout first (has balances + metadata), falls back to Etherscan.
 * Saves discovered tokens to useCustomTokenStore and returns count added.
 */
export async function scanTokensFromExplorer(
  walletAddress: string,
  chainId: number,
): Promise<number> {
  let tokens = await fetchBlockscoutTokens(walletAddress, chainId);

  // Fallback to Etherscan-compatible API if Blockscout returned nothing.
  // Etherscan tokentx only gives transfer history — must verify current balance
  // via on-chain balanceOf so we don't add zero-balance tokens that get hidden.
  if (tokens.length === 0) {
    const candidates = await fetchEtherscanTokens(walletAddress, chainId);
    if (candidates.length > 0) {
      const amounts = await batchFetchBalances(
        walletAddress,
        candidates.map(t => ({ address: t.address, decimals: t.decimals })),
        chainId,
      );
      tokens = candidates
        .map((t, i) => ({ ...t, balance: amounts[i] ?? 0 }))
        .filter(t => t.balance > 0);
    }
  }

  if (tokens.length === 0) return 0;

  const store = useCustomTokenStore.getState();
  const prevCount = store.getByChainId(chainId).length;

  const toDiscover: Omit<CustomToken, "id" | "addedAt">[] = tokens.map(t => ({
    chainId,
    address:          t.address,
    symbol:           t.symbol,
    name:             t.name,
    decimals:         t.decimals,
    color:            "#6B7280",
    isAutoDiscovered: true,
  }));

  store.addAutoDiscovered(toDiscover);

  // Return how many tokens were actually new (not already in store)
  const newCount = useCustomTokenStore.getState().getByChainId(chainId).length;
  return newCount - prevCount;
}

/* ─── Auto-discovery via Transfer event logs ──────────────────────────────── */

const TRANSFER_TOPIC  = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SYMBOL_SEL      = "0x95d89b41";
const NAME_SEL        = "0x06fdde03";
const DECIMALS_SEL    = "0x313ce567";

/** Sessions already scanned — stores timestamp of last scan per address+chainId. */
const discoverySessions = new Map<string, number>();
const DISCOVERY_COOLDOWN_MS = 5 * 60 * 1000; // re-allow after 5 minutes

function padTopic(addr: string): string {
  return "0x" + addr.toLowerCase().replace("0x", "").padStart(64, "0");
}

function decodeAbiString(hex: string): string {
  try {
    if (!hex || hex.length < 130) return "";
    const len = parseInt(hex.slice(66, 130), 16);
    if (len === 0 || len > 80) return "";
    const chars = hex.slice(130, 130 + len * 2).match(/.{1,2}/g) ?? [];
    return chars
      .map(b => String.fromCharCode(parseInt(b, 16)))
      .filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127)
      .join("")
      .trim();
  } catch { return ""; }
}

function decodeUint8(hex: string): number {
  if (!hex || hex.length < 4) return 18;
  try { return parseInt(hex.slice(-2), 16) || 18; } catch { return 18; }
}

/**
 * Scans Transfer event logs for ERC-20 tokens received by this wallet,
 * fetches metadata for unknown contracts, and persists them in useCustomTokenStore.
 * Re-runs after DISCOVERY_COOLDOWN_MS (5 min). Pass forceRescan=true to bypass cooldown.
 */
export async function discoverNewTokens(
  walletAddress: string,
  chainId: number,
  knownAddressSet: Set<string>,
  forceRescan = false,
): Promise<void> {
  const key = `${walletAddress.toLowerCase()}_${chainId}`;
  const lastScan = discoverySessions.get(key) ?? 0;
  if (!forceRescan && Date.now() - lastScan < DISCOVERY_COOLDOWN_MS) return;
  discoverySessions.set(key, Date.now());

  try {
    let blockHex: string;
    try { blockHex = await rpcCall("eth_blockNumber", [], chainId); }
    catch { return; }
    const currentBlock = parseInt(blockHex, 16);

    const tryGetLogs = async (blockRange: number) => {
      const fromBlock = "0x" + Math.max(0, currentBlock - blockRange).toString(16);
      return rpcCall("eth_getLogs", [{
        fromBlock,
        toBlock: "latest",
        topics: [TRANSFER_TOPIC, null, padTopic(walletAddress)],
      }], chainId);
    };

    // Try progressively smaller ranges until the RPC accepts the request
    let logs: any[] = [];
    for (const range of [50_000, 10_000, 2_000]) {
      try { logs = await tryGetLogs(range); break; }
      catch { /* try smaller range */ }
    }

    if (!Array.isArray(logs) || logs.length === 0) return;

    const newContracts = [
      ...new Set(
        logs
          .map((l: any) => l.address?.toLowerCase())
          .filter((a): a is string => !!a && !knownAddressSet.has(a)),
      ),
    ].slice(0, 50);

    if (newContracts.length === 0) return;

    const discovered: Omit<CustomToken, "id" | "addedAt">[] = [];

    await Promise.allSettled(
      newContracts.map(async (contractAddr) => {
        try {
          const [symHex, nameHex, decHex] = await Promise.all([
            rpcCall("eth_call", [{ to: contractAddr, data: SYMBOL_SEL   }, "latest"], chainId),
            rpcCall("eth_call", [{ to: contractAddr, data: NAME_SEL     }, "latest"], chainId),
            rpcCall("eth_call", [{ to: contractAddr, data: DECIMALS_SEL }, "latest"], chainId),
          ]);
          const symbol   = decodeAbiString(symHex);
          const name     = decodeAbiString(nameHex);
          const decimals = decodeUint8(decHex);
          if (symbol && name && symbol.length >= 2 && symbol.length <= 15) {
            discovered.push({
              chainId,
              address:          contractAddr,
              symbol,
              name,
              decimals,
              color:            "#6B7280",
              isAutoDiscovered: true,
            });
          }
        } catch { /* skip bad contracts */ }
      }),
    );

    if (discovered.length > 0) {
      useCustomTokenStore.getState().addAutoDiscovered(discovered);
    }
  } catch { /* discovery is non-fatal */ }
}

// ─── Module-level balance cache ───────────────────────────────────────────────
// Survives component remounts so the wallet never flashes empty when the user
// navigates away and back.  Also shared between useAllEvmBalances (portfolio
// total) and EvmChainRow (token list) so duplicate hook instances for the same
// address+chain attach to one in-flight fetch instead of firing separate RPC
// storms.
const _balanceCache = new Map<string, { balances: TokenBalance[]; fetchedAt: number }>();
const _inFlight     = new Map<string, Promise<void>>();
const CACHE_TTL_MS  = 60_000; // re-use cached data if fresher than 60 s

export function useEvmBalances(address: string | null, chainId: number | null) {
  const cacheKey = address && chainId ? `${address.toLowerCase()}_${chainId}` : null;
  const _cached  = cacheKey ? _balanceCache.get(cacheKey) : undefined;

  const [balances,  setBalances]  = useState<TokenBalance[]>(_cached?.balances ?? []);
  const [loading,   setLoading]   = useState(false);
  const [lastFetch, setLastFetch] = useState(_cached?.fetchedAt ?? 0);

  const fetch = useCallback(async () => {
    if (!address || !chainId || !cacheKey) return;

    // If a fetch is already in-flight for this address+chain, attach to it so
    // duplicate hook instances (useAllEvmBalances + EvmChainRow) share one RPC
    // round-trip instead of hammering the endpoint simultaneously.
    const existing = _inFlight.get(cacheKey);
    if (existing) {
      await existing;
      const c = _balanceCache.get(cacheKey);
      if (c) { setBalances(c.balances); setLastFetch(c.fetchedAt); }
      return;
    }

    // Skip fetch if cache is still fresh (e.g. second hook instance mounts
    // within CACHE_TTL_MS of the first).
    if (_cached && Date.now() - _cached.fetchedAt < CACHE_TTL_MS) {
      setBalances(_cached.balances);
      setLastFetch(_cached.fetchedAt);
      return;
    }

    const resolvedChainId: number = chainId;

    // Register this fetch as in-flight so concurrent hook instances can attach.
    let _resolve!: () => void;
    const promise = new Promise<void>(r => { _resolve = r; });
    _inFlight.set(cacheKey, promise);

    setLoading(true);
    try {
      async function fetchNativeAmount(): Promise<number> {
        const config = getWagmiConfig();
        if (config) {
          try {
            const { getBalance } = await import("@wagmi/core");
            const result = await getBalance(config, {
              address: address as `0x${string}`,
              chainId: resolvedChainId as any, // wagmi chain union — runtime-validated against configured chains
            });
            return Number(result.value) / 1e18;
          } catch { /* fall through */ }
        }
        const hex = await rpcCall("eth_getBalance", [address, "latest"], resolvedChainId);
        return Number(BigInt(hex)) / 1e18;
      }

      const [usdPrices, nativeAmount] = await Promise.all([
        fetchMarketPrices(),
        fetchNativeAmount(),
      ]);

      const customChain = useCustomChainStore.getState().getById(chainId);
      const nativeDef   = NATIVE_TOKENS[chainId] ?? (customChain ? { symbol: customChain.symbol, name: customChain.nativeName, color: "#22C55E", cgId: customChain.symbol.toLowerCase() } : { symbol: "ETH", name: "Ethereum", color: "#8B5CF6", cgId: "ethereum" });
      const nativeTick  = usdPrices[nativeDef.symbol] ?? usdPrices["ETH"] ?? { usd: 0, change24h: 0 };
      const nativePrice = typeof nativeTick === "number" ? nativeTick : nativeTick.usd;
      const nativeChange = typeof nativeTick === "number" ? 0 : nativeTick.change24h;

      const result: TokenBalance[] = [];
      result.push({
        symbol:    nativeDef.symbol,
        name:      nativeDef.name,
        amount:    nativeAmount,
        usdValue:  nativeAmount * nativePrice,
        price:     nativePrice,
        change24h: nativeChange,
        color:     nativeDef.color,
        decimals:  18,
        isNative:  true,
      });

      // Build token list: built-ins + tokens from store
      // isAutoDiscovered tokens act like built-ins (hidden at 0 balance)
      // manually-added tokens always shown even at 0 balance
      const builtInTokens = ERC20_TOKENS[chainId] ?? [];
      const storeTokens   = useCustomTokenStore.getState().getByChainId(chainId).map(ct => ({
        symbol:   ct.symbol,
        name:     ct.name,
        address:  ct.address,
        decimals: ct.decimals,
        color:    ct.color,
        isCustom: !ct.isAutoDiscovered,
      }));

      const tokens = [
        ...builtInTokens.map(t => ({ ...t, isCustom: false as const })),
        ...storeTokens,
      ];

      // Batch all balanceOf calls in one JSON-RPC request
      const amounts = await batchFetchBalances(address, tokens, chainId);

      const knownAddresses = new Set(builtInTokens.map(t => t.address.toLowerCase()));
      useCustomTokenStore.getState().getByChainId(chainId)
        .forEach(ct => knownAddresses.add(ct.address.toLowerCase()));

      for (let i = 0; i < tokens.length; i++) {
        const token  = tokens[i];
        const amount = amounts[i] ?? 0;
        if (amount <= 0 && !token.isCustom) continue;

        const tick  = usdPrices[token.symbol];
        const price = tick ? (typeof tick === "number" ? tick : tick.usd) : 0;
        const ch24  = tick ? (typeof tick === "number" ? 0   : tick.change24h) : 0;
        result.push({
          symbol:          token.symbol,
          name:            token.name,
          amount,
          usdValue:        amount * price,
          price,
          change24h:       ch24,
          color:           token.color,
          decimals:        STABLECOINS.has(token.symbol) ? 2
                           : (token.symbol === "WBTC" || token.symbol === "cbBTC") ? 6 : 4,
          contractAddress: token.address,
          isCustom:        token.isCustom,
        });
      }

      result.sort((a, b) => b.usdValue - a.usdValue);
      // Write to module-level cache before notifying React so any concurrent
      // hook instances that attach to the in-flight promise get fresh data.
      const fetchedAt = Date.now();
      _balanceCache.set(cacheKey, { balances: result, fetchedAt });
      setBalances(result);
      setLastFetch(fetchedAt);

      // Background: auto-discover tokens the user holds.
      // Prefer the Blockscout/explorer API (full history, like MetaMask).
      // Fall back to Transfer-log scanning for unsupported chains.
      if (BLOCKSCOUT_URLS[chainId] || ETHERSCAN_URLS[chainId]) {
        scanTokensFromExplorer(address, chainId).catch(() => {
          discoverNewTokens(address, chainId, knownAddresses);
        });
      } else {
        discoverNewTokens(address, chainId, knownAddresses);
      }

      // Background: for tokens with balance > 0 but unknown price, look up via
      // CoinGecko contract-address API (covers newly discovered / niche tokens)
      const unpriced = result.filter(t => !t.isNative && t.amount > 0 && t.price === 0 && t.contractAddress);
      if (unpriced.length > 0) {
        fetchContractPrices(
          unpriced.map(t => t.contractAddress!.toLowerCase()),
          chainId,
        ).then(cgPrices => {
          if (Object.keys(cgPrices).length === 0) return;
          setBalances(prev => {
            const updated = prev.map(t => {
              if (!t.contractAddress || t.price > 0) return t;
              const p = cgPrices[t.contractAddress.toLowerCase()];
              if (!p) return t;
              return { ...t, price: p, usdValue: t.amount * p };
            });
            updated.sort((a, b) => b.usdValue - a.usdValue);
            return updated;
          });
        }).catch(() => { /* non-fatal */ });
      }
    } catch (err) {
      console.error("EVM balance fetch error:", err);
    } finally {
      setLoading(false);
      // Resolve the in-flight promise so waiting hook instances wake up.
      _inFlight.delete(cacheKey);
      _resolve();
    }
  }, [address, chainId, cacheKey]);

  useEffect(() => {
    if (!address || !chainId) return;
    fetch();
    const id = setInterval(fetch, 30_000);
    return () => clearInterval(id);
  }, [fetch]);

  // Re-fetch when the browser tab becomes visible again.  Browsers throttle
  // setInterval to ~60 s (or longer) for background tabs, so without this a
  // user returning to the wallet page could see balances that are minutes
  // stale.  visibilitychange fires the moment they bring the tab forward.
  useEffect(() => {
    if (!address || !chainId) return;
    const onVisible = () => { if (document.visibilityState === "visible") fetch(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [address, chainId, fetch]);

  // Re-fetch immediately when a custom token is added/removed for this chain
  // so the balance list updates without waiting for the next 30s tick.
  useEffect(() => {
    if (!address || !chainId) return;
    let prevCount = useCustomTokenStore.getState().getByChainId(chainId).length;
    const unsub = useCustomTokenStore.subscribe(state => {
      const count = state.getByChainId(chainId).length;
      if (count !== prevCount) {
        prevCount = count;
        // Bust the cache so the re-fetch always hits the RPC (the token list
        // changed — stale cache would suppress the update).
        if (cacheKey) _balanceCache.delete(cacheKey);
        fetch();
      }
    });
    return unsub;
  }, [address, chainId, cacheKey, fetch]);

  return { balances, loading, refresh: fetch, lastFetch };
}
