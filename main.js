import fs from "fs/promises";
import axios from "axios";
import readline from "readline";
import { getBanner } from "./config/banner.js";
import { colors } from "./config/colors.js";
import { Wallet } from "ethers";
import HttpsProxyAgent from "https-proxy-agent"; // Tambahkan modul untuk proxy

const CONFIG = {
  PING_INTERVAL: 0.5,
  get PING_INTERVAL_MS() {
    return this.PING_INTERVAL * 60 * 1000;
  },
};

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);

class WalletDashboard {
  constructor() {
    this.wallets = [];
    this.selectedIndex = 0;
    this.currentPage = 0;
    this.walletsPerPage = 5;
    this.isRunning = true;
    this.pingIntervals = new Map();
    this.walletStats = new Map();
    this.privateKeys = new Map();
    this.proxies = new Map(); // Tambahkan map untuk proxy
    this.renderTimeout = null;
    this.lastRender = 0;
    this.minRenderInterval = 100;
  }

  async initialize() {
    try {
      const data = await fs.readFile("data.txt", "utf8");
      const lines = data.split("\n").filter((line) => line.trim() !== "");

      this.wallets = [];
      this.privateKeys = new Map();
      this.proxies = new Map(); // Map untuk menyimpan proxy

      for (let line of lines) {
        const [privateKey, proxy] = line.split(","); // Pisahkan private key dan proxy
        try {
          const wallet = new Wallet(privateKey.trim());
          const address = wallet.address;

          this.wallets.push(address);
          this.privateKeys.set(address, privateKey.trim());
          this.proxies.set(address, proxy ? proxy.trim() : null); // Simpan proxy untuk wallet

          this.walletStats.set(address, {
            status: "Starting",
            lastPing: "-",
            points: 0,
            error: null,
          });

          this.startPing(address); // Mulai ping untuk wallet ini
        } catch (error) {
          console.error(
            `${colors.error}Invalid private key: ${privateKey} - ${error.message}${colors.reset}`
          );
        }
      }

      if (this.wallets.length === 0) {
        throw new Error("No valid private keys found in data.txt");
      }
    } catch (error) {
      console.error(
        `${colors.error}Error reading data.txt: ${error}${colors.reset}`
      );
      process.exit(1);
    }
  }

  getApi(wallet) {
    const proxyUrl = this.proxies.get(wallet); // Ambil proxy untuk wallet
    const axiosConfig = {
      baseURL: "https://referralapi.layeredge.io/api",
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/json",
        Origin: "https://referralapi.layeredge.io",
        Referer: "https://referralapi.layeredge.io/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      timeout: 30000,
    };

    // Jika proxy digunakan, tambahkan konfigurasi proxy
    if (proxyUrl) {
      const agent = new HttpsProxyAgent(proxyUrl);
      axiosConfig.httpAgent = agent;
      axiosConfig.httpsAgent = agent;
      axiosConfig.proxy = false; // Nonaktifkan pengaturan proxy default axios
    }

    return axios.create(axiosConfig);
  }

  async signAndStart(wallet, privateKey) {
    try {
      const walletInstance = new Wallet(privateKey);
      const timestamp = Date.now();
      const message = `Node activation request for ${wallet} at ${timestamp}`;
      const sign = await walletInstance.signMessage(message);

      const response = await this.getApi(wallet).post(
        `/light-node/node-action/${wallet}/start`,
        {
          sign: sign,
          timestamp: timestamp,
        }
      );

      return response.data?.message === "node action executed successfully";
    } catch (error) {
      throw new Error(`Node activation failed: ${error.message}`);
    }
  }

  async checkNodeStatus(wallet, retries = 20) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await this.getApi(wallet).get(
          `/light-node/node-status/${wallet}`
        );
        return response.data?.data?.startTimestamp !== null;
      } catch (error) {
        if (i === retries - 1) {
          if (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED") {
            throw new Error(
              "Connection timeout, please check your internet connection"
            );
          }
          if (error.response?.status === 404) {
            throw new Error("Node not found");
          }
          throw new Error(`Check status failed: ${error.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
    }
  }

  async checkPoints(wallet) {
    try {
      const response = await this.getApi(wallet).get(
        `/referral/wallet-details/${wallet}`
      );
      return response.data?.data?.nodePoints || 0;
    } catch (error) {
      throw new Error(`Check points failed: ${error.message}`);
    }
  }

  // Metode lainnya tetap sama...
}

const dashboard = new WalletDashboard();
dashboard.start().catch((error) => {
  console.error(`${colors.error}Fatal error: ${error}${colors.reset}`);
  process.exit(1);
});
