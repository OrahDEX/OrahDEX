/**
 * On-chain liquidity provision for OrahDEX.
 *
 * Wallet provider resolution order (handles both injected wallets AND WalletConnect):
 *   1. window.ethereum  — MetaMask, Coinbase Wallet, injected extension
 *   2. wagmi WalletClient — WalletConnect, Reown AppKit (mobile)
 *
 * Three deposit modes, automatically selected by chain + pair:
 *
 *  "on_chain"  – Uniswap V3 real deposit (ETH/BTC pairs on Base or Ethereum).
 *                Actual tokens deducted from wallet.
 *
 *  "live"      – EVM wallet connected but pair has no V3 pool yet.
 *                Position recorded against real wallet address; no transfer.
 *
 *  "simulated" – Non-EVM wallet or unsupported chain.
 */

import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import {
  sendTransaction as coreSendTx,
  writeContract  as coreWriteContract,
  signMessage    as coreSignMessage,
} from "@wagmi/core";
import { checkAllowance, pollTxReceipt, getWagmiConfig, CHAIN_RPC_URLS } from "./reown";
import { getOrahAmm, hasOrahAmm, ORAH_ROUTER_ABI, ORAH_FACTORY_ABI } from "./orahAmmAddresses";

// ─── EVM chains we recognise ──────────────────────────────────────────────────
const EVM_CHAIN_IDS = new Set([
  1, 56, 137, 42161, 10, 8453,
  59144, 324, 534352, 5000, 43114, 250, 25,
  11155111, 84532,  // testnets: Sepolia, Base Sepolia
]);

// ─── Token addresses per chain ────────────────────────────────────────────────
// Used by resolveEscrowAsset (escrow.ts) to build lockERC20 calldata, and by
// the Uniswap V3 liquidity provision path. Add new tokens here to unlock
// on-chain escrow locking for that pair.
export const CHAIN_TOKEN_ADDRESSES: Record<number, Partial<Record<string, string>>> = {
  // ── Ethereum Mainnet ────────────────────────────────────────────────────────
  1: {
    // Stablecoins
    USDT:    "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    USDC:    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    DAI:     "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    FRAX:    "0x853d955aCEf822Db058eb8505911ED77F175b99e",
    TUSD:    "0x0000000000085d4780B73119b644AE5ecd22b376",
    LUSD:    "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0",
    USDP:    "0x8E870D67F660D95d5be530380D0eC0bd388289E1",
    // Wrapped assets
    WETH:    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    WBTC:    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    WSTETH:  "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
    STETH:   "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
    RETH:    "0xae78736Cd615f374D3085123A210448E74Fc6393",
    CBETH:   "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
    WSOL:    "0xD31a59c85aE9D8edEFec411D448f90841571b89c",
    // DeFi blue-chips
    LINK:    "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    UNI:     "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    AAVE:    "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    MKR:     "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
    SNX:     "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6f",
    COMP:    "0xc00e94Cb662C3520282E6f5717214004A7f26888",
    CRV:     "0xD533a949740bb3306d119CC777fa900bA034cd52",
    BAL:     "0xba100000625a3754423978a60c9317c58a424e3D",
    YFI:     "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e",
    SUSHI:   "0x6B3595068778DD592e39A122f4f5a5cF09C90fE2",
    "1INCH": "0x111111111117dC0aa78b770fA6A738034120C302",
    GRT:     "0xc944E90C64B2c07662A292be6244BDf05Cda44a7",
    LDO:     "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32",
    RPL:     "0xD33526068D116cE69F19A9ee46F0bd304F21A51f",
    DYDX:    "0x92D6C1e31e14520e676a687F0a93788B716BEff5",
    LRC:     "0xBBbbCA6A901c926F240b89EacB641d8Aec7AEafD",
    ENS:     "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72",
    OCEAN:   "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
    CVX:     "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B",
    FXS:     "0x3432B6A60D23Ca0dFCa7761B7AB56459D9C964D0",
    SPELL:   "0x090185f2135308baD17527004364eBcC2D37e5F6",
    // L2 / infrastructure
    ARB:     "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1",
    OP:      "0x4200000000000000000000000000000000000042",
    IMX:     "0xF57e7e7C23978C3cAEC3C3548E3D615c346e79fF",
    MATIC:   "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0",
    CELR:    "0x4F9254C83eb525f9FCf346490bBB3ed28a81C667",
    // Gaming / metaverse
    A8:      "0x3e5a19c91266ad8ce2477b91585d1856b84062df",
    MANA:    "0x0F5D2fB29fb7d3CFeE444a200298f468908cC942",
    SAND:    "0x3845badAde8e6dFF049820680d1F14bD3903a5d0",
    AXS:     "0xBB0E17EF65F82Ab018d8EDd776e8DD940327B28b",
    APE:     "0x4d224452801ACEd8B2F0aEbe155379bb5D594381",
    CHZ:     "0x3506424f91fD33084466F402d5D97f05F8e3b4AF",
    ENJ:     "0xF629cBd94d3791C9250152BD8dfBDF380E2a3B9c",
    GALA:    "0xd1d2Eb1B1e90b638588728b4130137D262C87cae",
    ILV:     "0x767FE9EDC9E0dF98E07454847909b5E959D7ca0E",
    // AI / data
    FET:     "0xaea46A60368A7bD060eec7df8CBa43b7EF41Ad85",
    AGIX:    "0x5B7533812759B45C2B44C19e320ba2CD2681b542",
    NMR:     "0x1776e1F26f98b1A5dF9cD347953a26dd3Cb46671",
    // Meme
    SHIB:    "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE",
    PEPE:    "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
    FLOKI:   "0xcf0C122c6b73Ff809C693DB761e7BaeBe62b6a2E",
    BONK:    "0x1151CB3d861920e07a38e03eEAD12C32178567F6",
    // Other alts
    FTM:     "0x4E15361FD6b4BB609Fa63C81A2be19d873717870",
    NEAR:    "0x85F17Cf997934a597031b2E18a9aB6ebD4B9F6a4",
    ZRX:     "0xE41d2489571d322189246DaFA5ebDe1F4699F498",
    BAT:     "0x0D8775F648430679A709E98d2b0Cb6250d2887EF",
    REN:     "0x408e41876cCCDC0F92210600ef50372656052a38",
    KNC:     "0xdeFA4e8a7bcBA345F687A2f1456F5Edd9CE97202",
    BNT:     "0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C",
    RLC:     "0x607F4C5BB672230e8672085532F7e901544a7375",
    STORJ:   "0xB64ef51C888972c908CFacf59B47C1AfBC0ab8aC",
    THETA:   "0x3883f5e181fccaF8410FA61e12b59Bad963fb645",
    VET:     "0xD850942eF8811f2A866692A623011Bde52a462C1",
    FIL:     "0x6e1A19F235bE7Ed8E3369eF73b196C07257494DE",
  },

  // ── BNB Smart Chain ─────────────────────────────────────────────────────────
  56: {
    USDT:    "0x55d398326f99059fF775485246999027B3197955",
    USDC:    "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    DAI:     "0x1AF3F329e8BE154074D8769D1FFa4EE058B1DBc3",
    BUSD:    "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    WBNB:    "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    BTCB:    "0x7130d2A12B9BCbFAe4f2634d864A1Ee1ce3ead9c",
    ETH:     "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
    CAKE:    "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
    LINK:    "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD",
    UNI:     "0xBf5140A22578168FD562DCcF235E5D43A02ce9B1",
    ADA:     "0x3EE2200Efb3400fAbB9AaC55E147E6D2BB5EFCD6",
    DOT:     "0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402",
    XRP:     "0x1D2F0da169ceb9fC7B3144628dB156f3F6c60dBe",
    DOGE:    "0xbA2aE424d960c26247Dd6c32edC70B295c744C43",
    LTC:     "0x4338665CBB7B2485A8855A139b75D5E34AB0DB94",
    MATIC:   "0xCC42724C6683B7E57334c4E856f4c9965ED682bD",
    AVAX:    "0x1CE0c2827e2eF14D5C4f29a091d735A204794041",
    ATOM:    "0x0Eb3a705fc54725037CC9e008bDede697f62F335",
    FTM:     "0xAD29AbB318791D579433D831ed122aFeAf29dcfe",
    INJ:     "0xa2B726B1145A4773F68593CF171187d8EBe4d495",
    NEAR:    "0x1Fa4a73a3F0133f0025378af00236f3ABDee5D63",
    SHIB:    "0x2859e4544C4bB03966803b044A93563bD2D0DD4D",
    PEPE:    "0x25d887Ce7a35172C62fEbfd67a1856F20FaEbB00",
    AAVE:    "0xfb6115445Bff7b52FeB98650C87f44907E58f802",
    SUSHI:   "0x947950BcE8AF41a37A12A7b8dEB5E0E35f8dBb3e",
    SNX:     "0x9Ac983826058b8a9C7Aa1C9171441191232E8404",
  },

  // ── Polygon ─────────────────────────────────────────────────────────────────
  137: {
    USDT:    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    USDC:    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    USDCE:   "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    DAI:     "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    WMATIC:  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    WETH:    "0x7ceB23fD6bC0add59E62ac25578270cFf1b9f619",
    WBTC:    "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BFd6",
    LINK:    "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
    AAVE:    "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
    UNI:     "0xb33EaAd8d922B1083446DC23f610c2567fB5180f",
    SUSHI:   "0x0b3F868E0BE5597D5DB7fEb59e1CADbb0fdDa50a",
    CRV:     "0x172370d5Cd63279eFa6d502dab29171933a610AF",
    BAL:     "0x9a71012B13Ca4d3D0Cdc72a177Df3ef03b0E76A3",
    SAND:    "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683",
    MANA:    "0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4",
    AXS:     "0x61BDD9C7d4dF4Bf47A4508c0c8245505F2AF5b7b",
    GHST:    "0x385Eeac5cB85A38A9a07A70c73e0a3271CfB54A7",
    IMX:     "0xa35923162C49cF95e6BF26623385EB431aD920D3",
    SNX:     "0x50B728D8D964fd00C2d0AAD81718b71311feF68b",
    GRT:     "0x5fe2B58c013d7601147DcdD68C143A77499f5531",
    ENS:     "0xb40178be0fcA0f0d57593B37C04f7ecCF1C9e23b",
  },

  // ── Base ────────────────────────────────────────────────────────────────────
  8453: {
    USDC:    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    USDBC:   "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    DAI:     "0x50c5725949A6F0c72E6c4a641f24049A917DB0Cb",
    USDT:    "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    WETH:    "0x4200000000000000000000000000000000000006",
    CBETH:   "0x2Ae3F1Ec7F1F5012CFEab0185bfC7aa3cf0DEc22",
    CBBTC:   "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    WBTC:    "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
    LINK:    "0x88Fb150BDc53A65fe94Dea0c9BA0a6daf8C6e196",
    AERO:    "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    OP:      "0x4200000000000000000000000000000000000042",
    BRETT:   "0x532f27101965dd16442E59d40670fAF5ebb142E4",
    TOSHI:   "0xAC1Bd2486Aaf3B5C0FC3fd868558b082a531B2b4",
  },

  // ── Arbitrum One ────────────────────────────────────────────────────────────
  42161: {
    USDT:    "0xFd086bC7CD5C481DCC9C85ebe478A1C0b69FCbb9",
    USDC:    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    USDCE:   "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    DAI:     "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    WETH:    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    WBTC:    "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    ARB:     "0x912CE59144191C1204E64559FE8253a0e49E6548",
    LINK:    "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
    UNI:     "0xFa7F8980b0f1E64A2062791cc3b0871572f1f7f0",
    GMX:     "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a",
    MAGIC:   "0x539bdE0d7Dbd336b79148AA742883198BBF60342",
    RDNT:    "0x3082CC23568eA640225c2467653dB90e9250aAA0",
    PENDLE:  "0x0c880f6761F1af8d9aA9C466984b80DAb9a8c9e8",
    SUSHI:   "0xd4d42F0b6DEF4CE0383636770eF773390d85c61A",
    CRV:     "0x11cDb42B0EB46d95f990BedD4695A6E3fA034978",
    BAL:     "0x040d1EdC9569d4Bab2D15287Dc5A4F10F56A56B8",
    AAVE:    "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196",
    STG:     "0x6694340fc020c5E6B96567843da2df01b2CE1eb6",
    SNX:     "0x9e295B5B976a184B14aD8cd72413aD846C299660",
    GRT:     "0x9623063377AD1B27544C965cCd7342f7EA7e88C7",
  },

  // ── Optimism ────────────────────────────────────────────────────────────────
  10: {
    USDC:    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    USDCE:   "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    USDT:    "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    DAI:     "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    WETH:    "0x4200000000000000000000000000000000000006",
    WBTC:    "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
    OP:      "0x4200000000000000000000000000000000000042",
    LINK:    "0x350a791Bfc2C21F9Ed5d10980dad2e2638ffa7f6",
    SNX:     "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4",
    VELO:    "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088db",
    PERP:    "0x9e1028F5F1D5EdE59748FFcee5532509976840E0",
    AAVE:    "0x76FB31fb4af56892a25e32cFc43De717950c9278",
    CRV:     "0x0994206dFE8de6eC6920FF4D779B0d950605Fb53",
    BAL:     "0xFE8B128bA8C78aabC59d4c64cEE7fF28e9379921",
    STG:     "0x296F55F8Fb28e498B858d0bcDA06D955B2Cb3f97",
    SUSHI:   "0x3eaEb77b03dBc0F6321AE1b72b2E9aDb0F60112B",
    WLD:     "0xdC6fF44d5d932Cbd77b52E5612Ba0529DC6226f1",
    SUSD:    "0x8c6f28f2F1A3C87F0f938b96d27520d9751ec8d9",
  },

  // ── Avalanche C-Chain ───────────────────────────────────────────────────────
  43114: {
    USDT:    "0x9702230A8Ea53601f5cD2dc00fDbC13d4dF4A8c7",
    USDC:    "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    USDCE:   "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664",
    DAI:     "0xd586E7F844CEa2F87f50152665BCbc2C279d8d70",
    WETH:    "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB",
    WBTC:    "0x50b7545627a5162F82A992c33b87aDc75187B218",
    WAVAX:   "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    JOE:     "0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd",
    LINK:    "0x5947BB275c521040051D82396192181b41227A3",
    AAVE:    "0x63a72806098Bd3D9520cC43356dD78afe5d386D9",
    GMX:     "0x62edc0692BD897D2295872a9FFcac5425011c661",
    PNG:     "0x60781C2586D68229fde47564546784Ab3fACA982",
    STG:     "0x2F6F07CDcf3588944Bf4C42aC74fF24bF56e7590",
    QI:      "0x8729438EB15e2C8b576fcc6AecDA6A148776C0F5",
    CRV:     "0x47536F17F4fF30e64A96a7555826b8f9e66ec468",
    SUSHI:   "0x37B608519F91f70F2EeB0e5Ed9AF4061722e4F76",
    UNI:     "0x8eBAf22B6F053dFFeaf46f4Dd9eFA95D89ba8580",
  },

  // ── Sepolia Testnet ─────────────────────────────────────────────────────────
  11155111: {
    WETH:    "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    USDC:    "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    USDT:    "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0",
    WBTC:    "0x29f2D40B0605204364af54EC677bD022dA425d03",
    DAI:     "0x68194a729C2450ad26072b3D33ADACbcef39D574",
    LINK:    "0x779877A7B0D9E8603169DdbD7836e478b4624789",
    UNI:     "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    AAVE:    "0x88541670E55cC00bEEFD87eB59EDd1b7C511AC9a",
  },
};

const UNI_V3_POSITION_MANAGER: Record<number, string> = {
  8453: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  1:    "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
};

const SUPPORTED_V3_PAIRS: Record<number, Set<string>> = {
  // Base mainnet: ETH/USDC and BTC/USDC are fully liquid on Uniswap V3
  8453: new Set(["ETH/USDC", "BTC/USDC"]),
  // Ethereum mainnet: deposit via live mode (position recorded, BSV-settled)
  // On-chain Uni V3 mint reverts due to pool price ratio constraints at small sizes
  // 1: new Set([...]) — intentionally empty; all Ethereum pairs use "live" mode
};

export const TOKEN_DECIMALS: Record<string, number> = {
  // Native / major
  ETH:     18, WETH:   18, BTC:    8,  WBTC:   8,
  SOL:     9,  WSOL:   9,  BSV:    8,  BNB:    18,
  XRP:     6,  ADA:    6,  DOGE:   8,  DOT:    10,
  MATIC:   18, AVAX:   18, WAVAX:  18, WMATIC: 18,
  FTM:     18, ONE:    18, NEAR:   24, ATOM:   6,
  // Stablecoins
  USDC:    6,  USDT:   6,  DAI:    18, FRAX:   18,
  TUSD:    18, LUSD:   18, USDP:   18, BUSD:   18,
  USDBC:   6,  USDCE:  6,  SUSD:   18, GHO:    18,
  // Wrapped / LSTs
  WSTETH:  18, STETH:  18, RETH:   18, CBETH:  18,
  CBBTC:   8,  BTCB:   18, WBNB:   18,
  // DeFi blue-chips
  LINK:    18, UNI:    18, AAVE:   18, MKR:    18,
  SNX:     18, COMP:   18, CRV:    18, BAL:    18,
  YFI:     18, SUSHI:  18, "1INCH":18, GRT:    18,
  LDO:     18, RPL:    18, DYDX:   18, LRC:    18,
  ENS:     18, OCEAN:  18, CVX:    18, FXS:    18,
  SPELL:   18, PERP:   18, VELO:   18, VELODROME: 18,
  STG:     18, PENDLE: 18, GMX:    18, GLP:    18,
  MAGIC:   18, RDNT:   18, AERO:   18, CAKE:   18,
  JOE:     18, PNG:    18, QI:     18, PEFI:   18,
  // L2 / infra
  ARB:     18, OP:     18, IMX:    18, CELR:   18,
  // Gaming / metaverse
  A8:      18,
  MANA:    18, SAND:   18, AXS:    18, APE:    18,
  CHZ:     18, ENJ:    18, GALA:   8,  ILV:    18,
  GHST:    18, BRETT:  18, TOSHI:  18,
  // AI / data
  FET:     18, AGIX:   8,  NMR:    18,
  // Meme
  SHIB:    18, PEPE:   18, FLOKI:  9,  BONK:   5,
  // Other alts
  ZRX:     18, BAT:    18, REN:    18, KNC:    18,
  BNT:     18, RLC:    9,  STORJ:  8,  THETA:  18,
  VET:     18, FIL:    18, INJ:    18, NEAR_:  18,
  // Cross-chain bridged
  ETH_BSC: 18, SNOB:   18, WLD:    18,
};

export const EXPLORER_TX: Record<number, string> = {
  8453:     "https://basescan.org/tx/",
  1:        "https://etherscan.io/tx/",
  56:       "https://bscscan.com/tx/",
  137:      "https://polygonscan.com/tx/",
  42161:    "https://arbiscan.io/tx/",
  10:       "https://optimistic.etherscan.io/tx/",
  59144:    "https://lineascan.build/tx/",
  324:      "https://explorer.zksync.io/tx/",
  43114:    "https://snowtrace.io/tx/",
  250:      "https://ftmscan.com/tx/",
  25:       "https://cronoscan.com/tx/",
  11155111: "https://sepolia.etherscan.io/tx/",
  84532:    "https://sepolia.basescan.org/tx/",
};

export const CHAIN_NAMES: Record<number, string> = {
  1:        "Ethereum",
  8453:     "Base",
  56:       "BNB Chain",
  137:      "Polygon",
  42161:    "Arbitrum",
  10:       "Optimism",
  59144:    "Linea",
  324:      "zkSync Era",
  43114:    "Avalanche",
  250:      "Fantom",
  25:       "Cronos",
  534352:   "Scroll",
  5000:     "Mantle",
  11155111: "Sepolia",
  84532:    "Base Sepolia",
};

// ─── Mode helpers ─────────────────────────────────────────────────────────────

export type LiquidityMode = "on_chain" | "orah_amm" | "live" | "simulated";

const INTERNAL_PROVIDERS = new Set([
  "orah-wallet", "passkey", "mobile-qr",
]);

export function hasExternalConnector(provider: string | null): boolean {
  if (!provider) return false;
  return !INTERNAL_PROVIDERS.has(provider);
}

export function getLiquidityMode(
  chainId: number | null,
  base: string,
  quote: string,
  provider?: string | null,
): LiquidityMode {
  if (!chainId || !EVM_CHAIN_IDS.has(chainId)) return "simulated";
  if (provider !== undefined && !hasExternalConnector(provider)) return "simulated";
  // OrahDEX-native AMM chains get real on-chain add/remove via OrahRouter02
  if (hasOrahAmm(chainId)) return "orah_amm";
  const pairKey = `${base.toUpperCase()}/${quote.toUpperCase()}`;
  const supported = SUPPORTED_V3_PAIRS[chainId];
  if (supported?.has(pairKey)) return "on_chain";
  return "live";
}

/** Legacy boolean helper. */
export function canUseOnChain(chainId: number | null, base: string): boolean {
  return getLiquidityMode(chainId, base, "USDT") === "on_chain";
}

// ─── Status type ─────────────────────────────────────────────────────────────

export type OnChainStep =
  | "idle" | "checking" | "approving" | "approval_pending"
  | "depositing" | "deposit_pending" | "success" | "error";

export interface LiquidityTxStatus {
  step: OnChainStep;
  txHash?: string;
  lpTokens?: number;
  valueUsd?: number;
  error?: string;
  /** OrahDEX LP token (pair) address — set on success for orah_amm mode */
  lpTokenAddress?: string;
}

// ─── Unified transaction helpers ─────────────────────────────────────────────
//
// Both functions use @wagmi/core top-level actions which internally route to
// whichever connector is active — MetaMask, Coinbase Wallet, WalletConnect,
// Reown AppKit mobile — without needing window.ethereum at all.

function requireConfig() {
  const cfg = getWagmiConfig();
  if (!cfg) throw new Error("Wallet not initialised. Please refresh and reconnect.");
  return cfg;
}

/**
 * Send a raw EVM transaction via whichever wallet is connected.
 * Works for injected wallets (MetaMask) AND WalletConnect / mobile.
 */
async function sendTx(
  _from: string,          // kept for API compatibility; wagmi reads account from connector
  to: `0x${string}`,
  data: `0x${string}`,
  valueWei: bigint,
  chainId: number,
): Promise<string> {
  const config = requireConfig();
  return await coreSendTx(config, {
    to,
    data,
    value: valueWei,
    chainId: chainId as any, // wagmi chain union — runtime-validated
  });
}

/**
 * ERC-20 approve(spender, amount) via whichever wallet is connected.
 * Uses exact amount only — never grants unlimited (maxUint256) allowance.
 */
async function approveErc20(
  tokenAddress: `0x${string}`,
  spender: `0x${string}`,
  _from: string,          // kept for API compatibility
  chainId: number,
  amount: bigint,         // exact approval amount
): Promise<string> {
  const config = requireConfig();
  return await coreWriteContract(config, {
    address:      tokenAddress,
    abi:          erc20Abi,
    functionName: "approve",
    args:         [spender, amount],
    chainId:      chainId as any, // wagmi chain union — runtime-validated
  });
}

// ─── Uniswap V3 ABI fragments ─────────────────────────────────────────────────

const MINT_ABI = [{
  name: "mint",
  type: "function",
  stateMutability: "payable",
  inputs: [{
    name: "params", type: "tuple",
    components: [
      { name: "token0",          type: "address"  },
      { name: "token1",          type: "address"  },
      { name: "fee",             type: "uint24"   },
      { name: "tickLower",       type: "int24"    },
      { name: "tickUpper",       type: "int24"    },
      { name: "amount0Desired",  type: "uint256"  },
      { name: "amount1Desired",  type: "uint256"  },
      { name: "amount0Min",      type: "uint256"  },
      { name: "amount1Min",      type: "uint256"  },
      { name: "recipient",       type: "address"  },
      { name: "deadline",        type: "uint256"  },
    ],
  }],
  outputs: [
    { name: "tokenId",    type: "uint256" },
    { name: "liquidity",  type: "uint128" },
    { name: "amount0",    type: "uint256" },
    { name: "amount1",    type: "uint256" },
  ],
}] as const;

const REFUND_ETH_ABI = [{
  name: "refundETH",
  type: "function",
  stateMutability: "payable",
  inputs: [],
  outputs: [],
}] as const;

const MULTICALL_ABI = [{
  name: "multicall",
  type: "function",
  stateMutability: "payable",
  inputs: [{ name: "data", type: "bytes[]" }],
  outputs: [{ name: "results", type: "bytes[]" }],
}] as const;

const TICK_LOWER = -887220;
const TICK_UPPER =  887220;
const FEE_TIER   = 3000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a decimal amount to wei using exact string-based math.
 * Avoids the `amount * 10**decimals` float-precision bug that loses
 * digits for large/odd values (e.g. 1.234567890123456789).
 *
 * Accepts both `number` and pre-formatted decimal strings.
 */
function toWei(amount: number | string, decimals: number): bigint {
  let str: string;
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount < 0) return 0n;
    // toLocaleString("fullwide") expands scientific notation safely.
    str = amount.toLocaleString("fullwide", {
      useGrouping: false,
      maximumFractionDigits: 30,
    });
  } else {
    str = amount.trim();
    if (!str) return 0n;
    // Normalise scientific notation if it sneaks in.
    if (/e/i.test(str)) {
      str = Number(str).toLocaleString("fullwide", {
        useGrouping: false,
        maximumFractionDigits: 30,
      });
    }
  }
  // Reject anything other than digits + at most one dot
  if (!/^[0-9]+(\.[0-9]+)?$/.test(str)) return 0n;
  return parseUnits(str as `${number}`, decimals);
}

/**
 * Apply slippage tolerance to a desired amount.
 * `bps` is basis points: 50 = 0.5%, 100 = 1%, capped at 5000 (50%).
 * Returns the minimum acceptable amount the user is willing to receive.
 */
function applySlippage(amount: bigint, bps: number): bigint {
  const safe = Math.max(0, Math.min(5000, Math.floor(bps)));
  if (safe === 0) return amount;
  return (amount * BigInt(10_000 - safe)) / 10_000n;
}

/** Default slippage tolerance when caller does not specify one. */
const DEFAULT_SLIPPAGE_BPS = 50;

// ─── Main export ─────────────────────────────────────────────────────────────

export interface AddLiquidityParams {
  base:     string;
  quote:    string;
  amountA:  number;
  amountB:  number;
  address:  string;
  chainId:  number;
  /** Slippage tolerance in basis points (50 = 0.5%). Defaults to 50 bps. */
  slippageBps?: number;
  onStatus: (s: LiquidityTxStatus) => void;
}

export async function addLiquidityOnChain(params: AddLiquidityParams): Promise<void> {
  const { base, quote, amountA, amountB, address, chainId, onStatus } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const update = (s: LiquidityTxStatus) => onStatus(s);

  const tokens  = CHAIN_TOKEN_ADDRESSES[chainId] ?? {};
  const posMan  = UNI_V3_POSITION_MANAGER[chainId] as `0x${string}` | undefined;

  if (!posMan) {
    update({ step: "error", error: "No V3 position manager for this chain." });
    return;
  }

  const baseKey   = base.toUpperCase() === "ETH" ? "WETH"
                  : base.toUpperCase() === "BTC"  ? "WBTC"
                  : base.toUpperCase();
  const quoteKey  = quote.toUpperCase();  // use the actual quote token — never swap USDT for USDC
  const baseAddr  = tokens[baseKey] as `0x${string}` | undefined;
  const quoteAddr = tokens[quoteKey] as `0x${string}` | undefined;

  if (!baseAddr || !quoteAddr) {
    update({ step: "error", error: `Token pair ${base}/${quote} is not supported on this network. Switch to Ethereum mainnet or use ETH/USDC on Base.` });
    return;
  }

  const baseDecimals  = TOKEN_DECIMALS[base.toUpperCase()] ?? 18;
  const quoteDecimals = TOKEN_DECIMALS[quoteKey] ?? 6;
  const baseWei       = toWei(amountA, baseDecimals);
  const quoteRaw      = toWei(amountB, quoteDecimals);

  const baseFirst      = baseAddr.toLowerCase() < quoteAddr.toLowerCase();
  const token0         = (baseFirst ? baseAddr  : quoteAddr) as `0x${string}`;
  const token1         = (baseFirst ? quoteAddr : baseAddr)  as `0x${string}`;
  const amount0Desired = baseFirst ? baseWei  : quoteRaw;
  const amount1Desired = baseFirst ? quoteRaw : baseWei;

  update({ step: "checking" });

  // ── Step 1: approve USDC (quote) ─────────────────────────────────────────
  let allowance = 0n;
  try { allowance = await checkAllowance(quoteAddr, address, posMan, chainId); } catch {}

  if (allowance < quoteRaw) {
    update({ step: "approving" });
    let approvalHash: string;
    try {
      approvalHash = await approveErc20(quoteAddr, posMan, address, chainId, quoteRaw);
    } catch (err: any) {
      const msg = err?.code === 4001 ? "Approval rejected by wallet."
                : err?.message ?? "Approval failed. Please try again.";
      update({ step: "error", error: msg });
      return;
    }

    update({ step: "approval_pending", txHash: approvalHash });

    await new Promise<void>((res, rej) => {
      const cancel = pollTxReceipt(approvalHash, chainId, {
        intervalMs: 3000, maxAttempts: 60,
        onReceipt: (r) => { cancel(); r.status === "0x1" ? res() : rej(new Error("Approval reverted.")); },
        onTimeout: () => { cancel(); rej(new Error("Approval timed out.")); },
      });
    }).catch(err => { update({ step: "error", error: err.message }); throw err; });
  }

  // ── Step 2: approve base token if it's also an ERC-20 (e.g., WBTC) ───────
  if (base.toUpperCase() !== "ETH") {
    let baseAllow = 0n;
    try { baseAllow = await checkAllowance(baseAddr, address, posMan, chainId); } catch {}
    if (baseAllow < baseWei) {
      update({ step: "approving" });
      let bHash: string;
      try {
        bHash = await approveErc20(baseAddr, posMan, address, chainId, baseWei);
      } catch (err: any) {
        const msg = err?.code === 4001 ? "Approval rejected by wallet."
                  : err?.message ?? "Base token approval failed.";
        update({ step: "error", error: msg });
        return;
      }
      update({ step: "approval_pending", txHash: bHash });
      await new Promise<void>((res, rej) => {
        const cancel = pollTxReceipt(bHash, chainId, {
          intervalMs: 3000, maxAttempts: 60,
          onReceipt: (r) => { cancel(); r.status === "0x1" ? res() : rej(new Error("Approval reverted.")); },
          onTimeout: () => { cancel(); rej(new Error("Approval timed out.")); },
        });
      }).catch(err => { update({ step: "error", error: err.message }); throw err; });
    }
  }

  // ── Step 3: send deposit tx ───────────────────────────────────────────────
  update({ step: "depositing" });

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const mintCalldata = encodeFunctionData({
    abi: MINT_ABI, functionName: "mint",
    args: [{
      token0, token1,
      fee: FEE_TIER, tickLower: TICK_LOWER, tickUpper: TICK_UPPER,
      amount0Desired, amount1Desired,
      amount0Min: applySlippage(amount0Desired, slippageBps),
      amount1Min: applySlippage(amount1Desired, slippageBps),
      recipient: address as `0x${string}`, deadline,
    }],
  });

  let depositHash: string;
  try {
    if (base.toUpperCase() === "ETH") {
      const refundData  = encodeFunctionData({ abi: REFUND_ETH_ABI, functionName: "refundETH", args: [] });
      const multicall   = encodeFunctionData({ abi: MULTICALL_ABI, functionName: "multicall", args: [[mintCalldata, refundData]] });
      depositHash = await sendTx(address, posMan, multicall as `0x${string}`, baseWei, chainId);
    } else {
      depositHash = await sendTx(address, posMan, mintCalldata as `0x${string}`, 0n, chainId);
    }
  } catch (err: any) {
    const msg = err?.code === 4001 ? "Transaction rejected by wallet."
              : err?.message ?? "Transaction failed. Please try again.";
    update({ step: "error", error: msg });
    return;
  }

  update({ step: "deposit_pending", txHash: depositHash });

  await new Promise<void>((res, rej) => {
    const cancel = pollTxReceipt(depositHash, chainId, {
      intervalMs: 3000, maxAttempts: 100,
      onReceipt: (r) => { cancel(); r.status === "0x1" ? res() : rej(new Error("Transaction reverted on-chain.")); },
      onTimeout: () => { cancel(); rej(new Error("Transaction timed out waiting for confirmation.")); },
    });
  }).catch(err => { update({ step: "error", error: err.message }); throw err; });

  const valueUsd = amountA * (SPOT_PRICES[base] ?? 1) + amountB * (SPOT_PRICES[quote] ?? 1);
  const lpTokens = valueUsd / 12.5;
  update({ step: "success", txHash: depositHash, lpTokens, valueUsd });
}

const SPOT_PRICES: Record<string, number> = {
  BTC: 83_000, ETH: 1_800, SOL: 130, BSV: 14, BNB: 580,
  XRP: 0.52, ADA: 0.44, DOGE: 0.12, DOT: 6.8, LINK: 14.5, USDT: 1, USDC: 1,
};

// ─── Live-mode: sign commitment, record position ──────────────────────────────
//
// For EVM wallets on chains where no V3 pool is available, we request a
// personal_sign so the user sees a wallet confirmation popup. No gas is spent.
// The signed message acts as proof-of-intent; position is stored locally.

export interface AddLiquidityLiveParams {
  base:      string;
  quote:     string;
  amountA:   number;
  amountB:   number;
  address:   string;
  chainId:   number;
  valueUsd:  number;
  lpTokens:  number;
  onStatus:  (s: LiquidityTxStatus) => void;
}

export async function addLiquidityLive(params: AddLiquidityLiveParams): Promise<void> {
  const { base, quote, amountA, amountB, address, chainId, valueUsd, lpTokens, onStatus } = params;

  onStatus({ step: "depositing" });

  const config = requireConfig();
  const timestamp = new Date().toISOString();
  const message =
    `OrahDEX Liquidity Commitment\n\n` +
    `Pool: ${base}/${quote}\n` +
    `Amount: ${amountA.toFixed(6)} ${base} + ${amountB.toFixed(6)} ${quote}\n` +
    `Value: $${valueUsd.toFixed(2)} USD\n` +
    `Wallet: ${address}\n` +
    `Network: Chain ${chainId}\n` +
    `Time: ${timestamp}\n\n` +
    `By signing you confirm your liquidity commitment. No gas is spent.`;

  let sig: string;
  try {
    sig = await coreSignMessage(config, { account: address as `0x${string}`, message });
  } catch (err: any) {
    const msg = err?.code === 4001 || err?.code === "ACTION_REJECTED"
      ? "Signature rejected. Liquidity not added."
      : err?.message ?? "Wallet signature failed.";
    onStatus({ step: "error", error: msg });
    return;
  }

  onStatus({ step: "success", lpTokens, valueUsd, txHash: sig.slice(0, 20) + "…" });
}

// ─── OrahDEX AMM helpers (raw JSON-RPC, no wagmi chain config required) ───────

/**
 * Raw eth_call via JSON-RPC — no dependency on wagmi chain list.
 * Used for reading on-chain data on any chain (including testnets).
 */
async function ethCallRaw(rpc: string, to: string, data: string): Promise<string | null> {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
    });
    const json = await res.json();
    return json?.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Poll for tx receipt on the given RPC.
 * Resolves when the tx is mined or after a timeout (~4 minutes).
 */
async function waitOrahTx(txHash: string, rpc: string): Promise<void> {
  const MAX_ATTEMPTS = 80;        // 80 × 3s = 4 minutes
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "eth_getTransactionReceipt",
          params: [txHash],
        }),
      });
      const json = await res.json();
      const receipt = json?.result;
      if (receipt?.blockHash) {
        // status: "0x1" = success, "0x0" = revert. Treat anything other than
        // explicit success as a revert to avoid silently accepting reverts.
        const status = String(receipt.status ?? "").toLowerCase();
        if (status === "0x1" || status === "1") return;
        throw new Error("Transaction reverted on-chain.");
      }
    } catch (err: any) {
      // Re-throw revert errors immediately; ignore transient network errors.
      if (err?.message?.includes("reverted")) throw err;
    }
  }
  throw new Error("Transaction timed out waiting for confirmation. Check the block explorer.");
}

/** Pad an address to 32-byte ABI slot. */
const padAddr = (a: string) => a.replace("0x", "").padStart(64, "0");

/**
 * Fetch the OrahDEX pair address from the factory for a token pair.
 * Returns undefined when the pair doesn't exist yet.
 */
async function getOrahPairAddress(
  rpc: string,
  factoryAddress: string,
  tokenA: string,
  tokenB: string,
): Promise<string | undefined> {
  try {
    const calldata = encodeFunctionData({
      abi: ORAH_FACTORY_ABI,
      functionName: "getPair",
      args: [tokenA as `0x${string}`, tokenB as `0x${string}`],
    });
    const raw = await ethCallRaw(rpc, factoryAddress, calldata);
    if (raw && raw !== "0x" && raw.length >= 66) {
      const addr = "0x" + raw.slice(-40);
      if (addr.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
        return addr;
      }
    }
  } catch {}
  return undefined;
}

// ─── addLiquidityOrahAmm ─────────────────────────────────────────────────────

export interface AddLiquidityOrahAmmParams {
  base:     string;
  quote:    string;
  amountA:  number;
  amountB:  number;
  address:  string;
  chainId:  number;
  /** Slippage tolerance in basis points (50 = 0.5%). Defaults to 50 bps. */
  slippageBps?: number;
  onStatus: (s: LiquidityTxStatus) => void;
}

/**
 * Add liquidity via OrahRouter02 on any chain where OrahDEX AMM is deployed.
 * Uses window.ethereum directly so it works on any wallet+chain without wagmi
 * network config (important for Sepolia which isn't in REOWN_NETWORKS).
 */
export async function addLiquidityOrahAmm(
  params: AddLiquidityOrahAmmParams,
): Promise<void> {
  const { base, quote, amountA, amountB, address, chainId, onStatus } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const update = (s: LiquidityTxStatus) => onStatus(s);

  const amm = getOrahAmm(chainId);
  if (!amm) {
    update({ step: "error", error: "OrahDEX AMM not deployed on this chain." });
    return;
  }

  const eth = (window as any).ethereum;
  if (!eth) {
    update({ step: "error", error: "No injected wallet found." });
    return;
  }

  const rpc = CHAIN_RPC_URLS[chainId];
  if (!rpc) {
    update({ step: "error", error: `No RPC URL for chain ${chainId}.` });
    return;
  }

  const tokens     = CHAIN_TOKEN_ADDRESSES[chainId] ?? {};
  const isETHBase  = base.toUpperCase()  === "ETH";
  const isETHQuote = quote.toUpperCase() === "ETH";
  const baseKey    = isETHBase  ? "WETH" : base.toUpperCase()  === "BTC" ? "WBTC" : base.toUpperCase();
  const quoteKey   = isETHQuote ? "WETH" : quote.toUpperCase() === "BTC" ? "WBTC" : quote.toUpperCase();

  const baseDecimals  = TOKEN_DECIMALS[base.toUpperCase()]  ?? 18;
  const quoteDecimals = TOKEN_DECIMALS[quote.toUpperCase()] ?? 6;
  const baseWei       = toWei(amountA, baseDecimals);
  const quoteWei      = toWei(amountB, quoteDecimals);
  const baseMin       = applySlippage(baseWei,  slippageBps);
  const quoteMin      = applySlippage(quoteWei, slippageBps);
  const deadline      = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const router        = amm.router;

  const resolvedTokenA = tokens[baseKey]  ?? amm.weth;
  const resolvedTokenB = tokens[quoteKey] ?? amm.weth;

  update({ step: "checking" });

  // Pre-read pair address so we can look it up before the pair might be created
  let pairAddress = await getOrahPairAddress(rpc, amm.factory, resolvedTokenA, resolvedTokenB);

  // ── Branch A: ETH + ERC-20 pair (addLiquidityETH) ─────────────────────────
  if (isETHBase || isETHQuote) {
    const tokenAddr   = (isETHBase  ? tokens[quoteKey] : tokens[baseKey]) as string | undefined;
    const tokenAmount = isETHBase  ? quoteWei : baseWei;
    const ethWei      = isETHBase  ? baseWei  : quoteWei;

    if (!tokenAddr) {
      update({ step: "error", error: `${isETHBase ? quote : base} token not configured for chain ${chainId}.` });
      return;
    }

    // Approve ERC-20 token to router
    const allowanceData = "0xdd62ed3e" + padAddr(address) + padAddr(router);
    const allowanceRaw  = await ethCallRaw(rpc, tokenAddr, allowanceData);
    const allowance     = allowanceRaw && allowanceRaw !== "0x" ? BigInt(allowanceRaw) : 0n;

    if (allowance < tokenAmount) {
      update({ step: "approving" });
      const approveData = "0x095ea7b3" + padAddr(router) + "f".repeat(64);
      let approveHash: string;
      try {
        approveHash = await eth.request({
          method: "eth_sendTransaction",
          params: [{ from: address, to: tokenAddr, data: approveData }],
        });
      } catch (err: any) {
        update({ step: "error", error: err?.code === 4001 ? "Approval rejected." : (err?.message ?? "Approval failed.") });
        return;
      }
      update({ step: "approval_pending", txHash: approveHash });
      try { await waitOrahTx(approveHash, rpc); }
      catch (err: any) { update({ step: "error", txHash: approveHash, error: err?.message ?? "Approval failed." }); return; }
    }

    update({ step: "depositing" });
    const calldata = encodeFunctionData({
      abi: ORAH_ROUTER_ABI,
      functionName: "addLiquidityETH",
      args: [
        tokenAddr as `0x${string}`,
        tokenAmount,
        applySlippage(tokenAmount, slippageBps),
        applySlippage(ethWei,      slippageBps),
        address as `0x${string}`,
        deadline,
      ],
    });

    let txHash: string;
    try {
      txHash = await eth.request({
        method: "eth_sendTransaction",
        params: [{ from: address, to: router, data: calldata, value: "0x" + ethWei.toString(16) }],
      });
    } catch (err: any) {
      update({ step: "error", error: err?.code === 4001 ? "Transaction rejected." : (err?.message ?? "Transaction failed.") });
      return;
    }

    update({ step: "deposit_pending", txHash });
    try { await waitOrahTx(txHash, rpc); }
    catch (err: any) { update({ step: "error", txHash, error: err?.message ?? "Deposit failed." }); return; }

    // Re-read pair address now that the pool may have been created
    if (!pairAddress) {
      pairAddress = await getOrahPairAddress(rpc, amm.factory, resolvedTokenA, resolvedTokenB);
    }

    const valueUsd = amountA * (SPOT_PRICES[base.toUpperCase()] ?? 1) + amountB * (SPOT_PRICES[quote.toUpperCase()] ?? 1);
    const lpTokens = valueUsd / 12.5;
    update({ step: "success", txHash, lpTokens, valueUsd, lpTokenAddress: pairAddress });
    return;
  }

  // ── Branch B: ERC-20 + ERC-20 pair (addLiquidity) ─────────────────────────
  const tokenAAddr = tokens[baseKey];
  const tokenBAddr = tokens[quoteKey];

  if (!tokenAAddr) {
    update({ step: "error", error: `${base} token not configured for chain ${chainId}.` });
    return;
  }
  if (!tokenBAddr) {
    update({ step: "error", error: `${quote} token not configured for chain ${chainId}.` });
    return;
  }

  // Approve tokenA
  const allowanceDataA = "0xdd62ed3e" + padAddr(address) + padAddr(router);
  const allowanceRawA  = await ethCallRaw(rpc, tokenAAddr, allowanceDataA);
  const allowanceA     = allowanceRawA && allowanceRawA !== "0x" ? BigInt(allowanceRawA) : 0n;

  if (allowanceA < baseWei) {
    update({ step: "approving" });
    const approveDataA = "0x095ea7b3" + padAddr(router) + "f".repeat(64);
    let approveHashA: string;
    try {
      approveHashA = await eth.request({
        method: "eth_sendTransaction",
        params: [{ from: address, to: tokenAAddr, data: approveDataA }],
      });
    } catch (err: any) {
      update({ step: "error", error: err?.code === 4001 ? "Approval rejected." : (err?.message ?? "Approval failed.") });
      return;
    }
    update({ step: "approval_pending", txHash: approveHashA });
    try { await waitOrahTx(approveHashA, rpc); }
    catch (err: any) { update({ step: "error", txHash: approveHashA, error: err?.message ?? "Approval failed." }); return; }
  }

  // Approve tokenB
  const allowanceDataB = "0xdd62ed3e" + padAddr(address) + padAddr(router);
  const allowanceRawB  = await ethCallRaw(rpc, tokenBAddr, allowanceDataB);
  const allowanceB     = allowanceRawB && allowanceRawB !== "0x" ? BigInt(allowanceRawB) : 0n;

  if (allowanceB < quoteWei) {
    update({ step: "approving" });
    const approveDataB = "0x095ea7b3" + padAddr(router) + "f".repeat(64);
    let approveHashB: string;
    try {
      approveHashB = await eth.request({
        method: "eth_sendTransaction",
        params: [{ from: address, to: tokenBAddr, data: approveDataB }],
      });
    } catch (err: any) {
      update({ step: "error", error: err?.code === 4001 ? "Approval rejected." : (err?.message ?? "Approval failed.") });
      return;
    }
    update({ step: "approval_pending", txHash: approveHashB });
    try { await waitOrahTx(approveHashB, rpc); }
    catch (err: any) { update({ step: "error", txHash: approveHashB, error: err?.message ?? "Approval failed." }); return; }
  }

  update({ step: "depositing" });
  const calldata = encodeFunctionData({
    abi: ORAH_ROUTER_ABI,
    functionName: "addLiquidity",
    args: [
      tokenAAddr as `0x${string}`, tokenBAddr as `0x${string}`,
      baseWei, quoteWei, baseMin, quoteMin,
      address as `0x${string}`, deadline,
    ],
  });

  let txHash: string;
  try {
    txHash = await eth.request({
      method: "eth_sendTransaction",
      params: [{ from: address, to: router, data: calldata }],
    });
  } catch (err: any) {
    update({ step: "error", error: err?.code === 4001 ? "Transaction rejected." : (err?.message ?? "Transaction failed.") });
    return;
  }

  update({ step: "deposit_pending", txHash });
  try {
    await waitOrahTx(txHash, rpc);
  } catch (err: any) {
    update({ step: "error", txHash, error: err?.message ?? "Deposit transaction failed." });
    return;
  }

  if (!pairAddress) {
    pairAddress = await getOrahPairAddress(rpc, amm.factory, tokenAAddr, tokenBAddr);
  }

  const valueUsd = amountA * (SPOT_PRICES[base.toUpperCase()] ?? 1) + amountB * (SPOT_PRICES[quote.toUpperCase()] ?? 1);
  const lpTokens = valueUsd / 12.5;
  update({ step: "success", txHash, lpTokens, valueUsd, lpTokenAddress: pairAddress });
}

// ─── removeLiquidityOrahAmm ──────────────────────────────────────────────────

export interface RemoveLiquidityOrahAmmParams {
  base:            string;
  quote:           string;
  pct:             number;          // 1–100
  address:         string;
  chainId:         number;
  lpTokenAddress?: string;          // pair contract address if already stored
  /** Slippage tolerance in basis points (50 = 0.5%). Defaults to 50 bps. */
  slippageBps?:    number;
  onStatus:        (s: LiquidityTxStatus) => void;
}

/**
 * Remove liquidity via OrahRouter02.
 * Reads the user's on-chain LP balance, approves the pair LP token to the router,
 * then calls removeLiquidity or removeLiquidityETH.
 */
export async function removeLiquidityOrahAmm(
  params: RemoveLiquidityOrahAmmParams,
): Promise<void> {
  const { base, quote, pct, address, chainId, lpTokenAddress: knownPair, onStatus } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const update = (s: LiquidityTxStatus) => onStatus(s);

  const amm = getOrahAmm(chainId);
  if (!amm) {
    update({ step: "error", error: "OrahDEX AMM not deployed on this chain." });
    return;
  }

  const eth = (window as any).ethereum;
  if (!eth) {
    update({ step: "error", error: "No injected wallet found." });
    return;
  }

  const rpc = CHAIN_RPC_URLS[chainId];
  if (!rpc) {
    update({ step: "error", error: `No RPC URL for chain ${chainId}.` });
    return;
  }

  const tokens     = CHAIN_TOKEN_ADDRESSES[chainId] ?? {};
  const isETHBase  = base.toUpperCase()  === "ETH";
  const isETHQuote = quote.toUpperCase() === "ETH";
  const baseKey    = isETHBase  ? "WETH" : base.toUpperCase()  === "BTC" ? "WBTC" : base.toUpperCase();
  const quoteKey   = isETHQuote ? "WETH" : quote.toUpperCase() === "BTC" ? "WBTC" : quote.toUpperCase();
  const tokenAAddr = (tokens[baseKey]  ?? amm.weth) as string;
  const tokenBAddr = (tokens[quoteKey] ?? amm.weth) as string;
  const router     = amm.router;
  const deadline   = BigInt(Math.floor(Date.now() / 1000) + 1800);

  update({ step: "checking" });

  // ── Resolve pair address ───────────────────────────────────────────────────
  let pairAddress = knownPair;
  if (!pairAddress) {
    pairAddress = await getOrahPairAddress(rpc, amm.factory, tokenAAddr, tokenBAddr);
  }

  if (!pairAddress) {
    update({ step: "error", error: `Pool ${base}/${quote} not found on-chain. Add liquidity first.` });
    return;
  }

  // ── Read LP balance ────────────────────────────────────────────────────────
  const balanceData = "0x70a08231" + padAddr(address);
  const balanceRaw  = await ethCallRaw(rpc, pairAddress, balanceData);
  const lpBalance   = balanceRaw && balanceRaw !== "0x" ? BigInt(balanceRaw) : 0n;

  if (lpBalance === 0n) {
    update({ step: "error", error: "No LP tokens found in wallet for this pair." });
    return;
  }

  const liquidity = (lpBalance * BigInt(pct)) / 100n;
  if (liquidity === 0n) {
    update({ step: "error", error: "Remove amount too small." });
    return;
  }

  // ── Approve LP tokens to router ───────────────────────────────────────────
  const lpAllowanceData = "0xdd62ed3e" + padAddr(address) + padAddr(router);
  const lpAllowanceRaw  = await ethCallRaw(rpc, pairAddress, lpAllowanceData);
  const lpAllowance     = lpAllowanceRaw && lpAllowanceRaw !== "0x" ? BigInt(lpAllowanceRaw) : 0n;

  if (lpAllowance < liquidity) {
    update({ step: "approving" });
    const approveData = "0x095ea7b3" + padAddr(router) + "f".repeat(64);
    let approveHash: string;
    try {
      approveHash = await eth.request({
        method: "eth_sendTransaction",
        params: [{ from: address, to: pairAddress, data: approveData }],
      });
    } catch (err: any) {
      update({ step: "error", error: err?.code === 4001 ? "Approval rejected." : (err?.message ?? "Approval failed.") });
      return;
    }
    update({ step: "approval_pending", txHash: approveHash });
    try { await waitOrahTx(approveHash, rpc); }
    catch (err: any) { update({ step: "error", txHash: approveHash, error: err?.message ?? "LP approval failed." }); return; }
  }

  // ── Call removeLiquidity / removeLiquidityETH ──────────────────────────────
  update({ step: "depositing" });

  const hasETH = isETHBase || isETHQuote;
  let calldata: string;

  // ── Read reserves + token0 so we can map mins to router argument order ──
  // OrahPair.getReserves() → (uint112 reserve0, uint112 reserve1, uint32 ts)
  // OrahPair.token0()      → address (lower of the two sorted tokens)
  // We need to map reserve0/reserve1 onto whichever token is named first in
  // the router call so amountAMin/amountBMin (or amountTokenMin/amountETHMin
  // for the ETH branch) are not transposed — a transposed min can revert a
  // valid withdrawal when reserves are skewed.
  const reservesData    = "0x0902f1ac";
  const totalSupplyData = "0x18160ddd";
  const token0Data      = "0x0dfe1681";
  const [reservesRaw, totalSupplyRaw, token0Raw] = await Promise.all([
    ethCallRaw(rpc, pairAddress, reservesData),
    ethCallRaw(rpc, pairAddress, totalSupplyData),
    ethCallRaw(rpc, pairAddress, token0Data),
  ]);

  let amountAMinPair = 0n;
  let amountBMinPair = 0n;
  if (
    reservesRaw && reservesRaw.length >= 194 &&
    totalSupplyRaw && totalSupplyRaw !== "0x" &&
    token0Raw && token0Raw !== "0x"
  ) {
    const clean    = reservesRaw.replace("0x", "");
    const reserve0 = BigInt("0x" + clean.slice(0, 64));
    const reserve1 = BigInt("0x" + clean.slice(64, 128));
    const totalSupply = BigInt(totalSupplyRaw);

    // token0Raw is a 32-byte ABI word; the address is its low 20 bytes.
    const token0Addr = ("0x" + token0Raw.slice(-40)).toLowerCase();

    // Decide which router arg position the user's "first" token (tokenAAddr,
    // or for the ETH branch, the ERC-20 token) is in, then map reserves
    // accordingly.
    let firstArgAddr: string;
    if (hasETH) {
      // Router arg order: (token, liquidity, amountTokenMin, amountETHMin, ...)
      firstArgAddr = (isETHBase ? tokens[quoteKey] : tokens[baseKey]) ?? tokenBAddr;
    } else {
      // Router arg order: (tokenA, tokenB, liquidity, amountAMin, amountBMin, ...)
      firstArgAddr = tokenAAddr;
    }

    if (totalSupply > 0n) {
      const expected0 = (liquidity * reserve0) / totalSupply;
      const expected1 = (liquidity * reserve1) / totalSupply;

      const firstIsToken0 = firstArgAddr.toLowerCase() === token0Addr;
      const expectedFirst  = firstIsToken0 ? expected0 : expected1;
      const expectedSecond = firstIsToken0 ? expected1 : expected0;

      amountAMinPair = applySlippage(expectedFirst,  slippageBps);
      amountBMinPair = applySlippage(expectedSecond, slippageBps);
    }
  }

  if (hasETH) {
    const erc20Addr = (isETHBase ? tokens[quoteKey] : tokens[baseKey]) ?? tokenBAddr;
    calldata = encodeFunctionData({
      abi: ORAH_ROUTER_ABI,
      functionName: "removeLiquidityETH",
      args: [
        erc20Addr as `0x${string}`,
        liquidity,
        amountAMinPair,    // amountTokenMin (mapped to ERC-20 token via token0 check)
        amountBMinPair,    // amountETHMin
        address as `0x${string}`,
        deadline,
      ],
    });
  } else {
    calldata = encodeFunctionData({
      abi: ORAH_ROUTER_ABI,
      functionName: "removeLiquidity",
      args: [
        tokenAAddr as `0x${string}`, tokenBAddr as `0x${string}`,
        liquidity,
        amountAMinPair,    // amountAMin → tokenA (token-order safe via token0 check)
        amountBMinPair,    // amountBMin → tokenB
        address as `0x${string}`, deadline,
      ],
    });
  }

  let txHash: string;
  try {
    txHash = await eth.request({
      method: "eth_sendTransaction",
      params: [{ from: address, to: router, data: calldata }],
    });
  } catch (err: any) {
    update({ step: "error", error: err?.code === 4001 ? "Transaction rejected." : (err?.message ?? "Transaction failed.") });
    return;
  }

  update({ step: "deposit_pending", txHash });
  try { await waitOrahTx(txHash, rpc); }
  catch (err: any) { update({ step: "error", txHash, error: err?.message ?? "Remove transaction failed." }); return; }
  update({ step: "success", txHash });
}
