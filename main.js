import fs from "fs/promises";
import axios from "axios";
import readline from "readline";
import { getBanner } from "./config/banner.js";
import { colors } from "./config/colors.js";
import { Wallet } from "ethers";
import HttpsProxyAgent from "https-proxy-agent";

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
    this.walletsPerPage = 6;
    this.isRunning = true;
    this.pingIntervals = new Map();
    this.walletStats = new Map();
    this.privateKeys = new Map();
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
    this.proxies = new Map(); // Map untuk menyimpan proxy per wallet

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
      Origin: "https://dashboard.layeredge.io",
      Referer: "https://dashboard.layeredge.io/",
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

      const response = await this.getApi().post(
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
        const response = await this.getApi().get(
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
      const response = await this.getApi().get(
        `/referral/wallet-details/${wallet}`
      );
      return response.data?.data?.nodePoints || 0;
    } catch (error) {
      throw new Error(`Check points failed: ${error.message}`);
    }
  }

  async updatePoints(wallet) {
    try {
      const timestamp = Date.now();

      const isRunning = await this.checkNodeStatus(wallet);
      if (!isRunning) {
        throw new Error("Node not running");
      }

      const points = await this.checkPoints(wallet);
      return { nodePoints: points };
    } catch (error) {
      if (error.response) {
        switch (error.response.status) {
          case 500:
            throw new Error("Internal Server Error");
          case 504:
            throw new Error("Gateway Timeout");
          case 403:
            throw new Error("Node not activated");
          default:
            throw new Error(`Update points failed: ${error.message}`);
        }
      }
      throw error;
    }
  }

  /*async checkPoints(wallet) {
    try {
      const response = await this.getApi().get(
        `/referral/wallet-details/${wallet}`
      );
  
      // Debug respons API
      console.log("API Full Response:", response.data);
  
      // Sesuaikan dengan struktur respons API
      if (!response.data?.data) {
        console.warn(`No points data found for wallet: ${wallet}`);
        return 0;
      }
  
      return response.data.data.nodePoints || 0;
    } catch (error) {
      console.error(`Error checking points for wallet: ${wallet}`, error.message);
      throw new Error(`Check points failed: ${error.message}`);
    }
  } */ 
  
  async startPing(wallet) {
    if (this.pingIntervals.has(wallet)) {
      return;
    }

    const stats = this.walletStats.get(wallet);

    try {
      const privateKey = this.privateKeys.get(wallet);
      if (!privateKey) {
        throw new Error("Private key not found for wallet");
      }

      stats.status = "Checking Status";
      this.renderDashboard();

      const isRunning = await this.checkNodeStatus(wallet);
      if (!isRunning) {
        stats.status = "Activating";
        this.renderDashboard();

        await this.signAndStart(wallet, privateKey);
        stats.status = "Activated";
        this.renderDashboard();

        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      const result = await this.updatePoints(wallet);
      stats.lastPing = new Date().toLocaleTimeString();
      stats.points = result.nodePoints || stats.points;
      stats.status = "Active";
      stats.error = null;
    } catch (error) {
      stats.status = "Error";
      stats.error = error.message;
      console.error(`Error starting node for ${wallet}:`, error.message);
      return;
    }

    const pingInterval = setInterval(async () => {
      try {
        const result = await this.updatePoints(wallet);
        const stats = this.walletStats.get(wallet);
        stats.lastPing = new Date().toLocaleTimeString();
        stats.points = result.nodePoints || stats.points;
        stats.status = "Active";
        stats.error = null;
      } catch (error) {
        const stats = this.walletStats.get(wallet);
        stats.status = "Error";
        stats.error = error.message;
      }
      this.renderDashboard();
    }, CONFIG.PING_INTERVAL_MS);

    this.pingIntervals.set(wallet, pingInterval);
    this.renderDashboard();
  }

  renderDashboard() {
    const now = Date.now();
    if (now - this.lastRender < this.minRenderInterval) {
      if (this.renderTimeout) {
        clearTimeout(this.renderTimeout);
      }
      this.renderTimeout = setTimeout(() => {
        this.actualRender();
      }, this.minRenderInterval);
      return;
    }

    this.actualRender();
  }

  actualRender() {
    this.lastRender = Date.now();
    let output = [];

    output.push("\x1b[2J\x1b[H");

    output.push(getBanner());

    const startIndex = this.currentPage * this.walletsPerPage;
    const endIndex = Math.min(
      startIndex + this.walletsPerPage,
      this.wallets.length
    );
    const totalPages = Math.ceil(this.wallets.length / this.walletsPerPage);

    for (let i = startIndex; i < endIndex; i++) {
      const wallet = this.wallets[i];
      const stats = this.walletStats.get(wallet);

      // Ambil proxy untuk wallet dan ekstrak hanya IP-nya
      const proxy = this.proxies.get(wallet) || "No Proxy";
      const proxyIp = proxy !== "No Proxy" ? proxy.split("@").pop().split(":")[0] : "No Proxy";

      const prefix =
        i === this.selectedIndex ? `${colors.cyan}→${colors.reset} ` : "  ";
      const shortWallet = `${wallet.substr(0, 6)}...${wallet.substr(-4)}`;

      output.push(
        `${prefix}Wallet: ${colors.accountName}${shortWallet}${colors.reset}`
      );
      output.push(
        `   Proxy: ${colors.info}${proxyIp}${colors.reset}` // Menampilkan hanya IP
      );
      output.push(
        `   Status: ${this.getStatusColor(stats.status)}${stats.status}${
          colors.reset
        }`
      );
      output.push(`   Points: ${colors.info}${stats.points}${colors.reset}`);
      output.push(
        `   Last Ping: ${colors.info}${stats.lastPing}${colors.reset}`
      );
      if (stats.error) {
        output.push(`   Error: ${colors.error}${stats.error}${colors.reset}`);
      }
      output.push("");
    }

    output.push(
      `\n${colors.menuBorder}Page ${this.currentPage + 1}/${totalPages}${
        colors.reset
      }`
    );
    output.push(`\n${colors.menuTitle}Configuration:${colors.reset}`);
    output.push(
      `${colors.menuOption}Ping Interval: ${CONFIG.PING_INTERVAL} minute(s)${colors.reset}`
    );
    output.push(`\n${colors.menuTitle}Controls:${colors.reset}`);
    output.push(
      `${colors.menuOption}↑/↓: Navigate | ←/→: Change Page | Ctrl+C: Exit${colors.reset}\n`
    );

    process.stdout.write(output.join("\n"));
  }

  getStatusColor(status) {
    switch (status) {
      case "Active":
        return colors.success;
      case "Error":
        return colors.error;
      case "Activated":
        return colors.taskComplete;
      case "Activation Failed":
        return colors.taskFailed;
      case "Starting":
        return colors.taskInProgress;
      case "Checking Status":
        return colors.taskInProgress;
      case "Activating":
        return colors.taskInProgress;
      default:
        return colors.reset;
    }
  }

  handleKeyPress(str, key) {
    const startIndex = this.currentPage * this.walletsPerPage;
    const endIndex = Math.min(
      startIndex + this.walletsPerPage,
      this.wallets.length
    );
    const totalPages = Math.ceil(this.wallets.length / this.walletsPerPage);

    if (key.name === "up" && this.selectedIndex > startIndex) {
      this.selectedIndex--;
      this.renderDashboard();
    } else if (key.name === "down" && this.selectedIndex < endIndex - 1) {
      this.selectedIndex++;
      this.renderDashboard();
    } else if (key.name === "left" && this.currentPage > 0) {
      this.currentPage--;
      this.selectedIndex = this.currentPage * this.walletsPerPage;
      this.renderDashboard();
    } else if (key.name === "right" && this.currentPage < totalPages - 1) {
      this.currentPage++;
      this.selectedIndex = this.currentPage * this.walletsPerPage;
      this.renderDashboard();
    }
  }

  async start() {
    process.on("SIGINT", function () {
      console.log(`\n${colors.info}Shutting down...${colors.reset}`);
      process.exit();
    });

    process.on("exit", () => {
      for (let [wallet, interval] of this.pingIntervals) {
        clearInterval(interval);
      }
      process.stdin.setRawMode(false);
      process.stdin.pause();
    });

    await this.initialize();
    this.renderDashboard();

    process.stdin.on("keypress", (str, key) => {
      if (key.ctrl && key.name === "c") {
        process.emit("SIGINT");
      } else {
        this.handleKeyPress(str, key);
      }
    });
  }
}

const dashboard = new WalletDashboard();
dashboard.start().catch((error) => {
  console.error(`${colors.error}Fatal error: ${error}${colors.reset}`);
  process.exit(1);
});
