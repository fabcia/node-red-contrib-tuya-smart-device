const TuyaDevice = require("tuyapi");

const CLIENT_STATUS = {
  DISCONNECTED: "DISCONNECTED",
  CONNECTED: "CONNECTED",
  CONNECTING: "CONNECTING",
  ERROR: "ERROR",
};
module.exports = function (RED) {
  function TuyaSmartDeviceNode(config) {
    RED.nodes.createNode(this, config);
    config.disableAutoStart = config.disableAutoStart || false;
    let node = this;
    let isConnected = false;
    let shouldTryReconnect = true;
    let shouldSubscribeData = true;
    let shouldSubscribeRefreshData = true;
    this.name = config.deviceName;
    this.deviceName = config.deviceName;
    this.deviceId = config.deviceId;
    this.deviceIp = config.deviceIp;
    this.disableAutoStart = config.disableAutoStart;
    this.eventMode = config.eventMode || "event-both";
    node.log(`Recieved the config ${JSON.stringify(config)}`);
    this.retryTimeout =
      config.retryTimeout == null ||
      typeof config.retryTimeout == "undefined" ||
      (typeof config.retryTimeout == "string" &&
        config.retryTimeout.trim() == "") ||
      (typeof config.retryTimeout == "number" && config.retryTimeout <= 0) ||
      isNaN(config.retryTimeout)
        ? 1000
        : config.retryTimeout;
    this.findTimeout =
      config.findTimeout == null ||
      typeof config.findTimeout == "undefined" ||
      (typeof config.findTimeout == "string" &&
        config.findTimeout.trim() == "") ||
      (typeof config.findTimeout == "number" && config.findTimeout <= 0) ||
      isNaN(config.findTimeout)
        ? 1000
        : config.findTimeout;
    this.tuyaVersion =
      config.tuyaVersion == null ||
      typeof config.tuyaVersion == "undefined" ||
      (typeof config.tuyaVersion == "string" &&
        config.tuyaVersion.trim() == "") ||
      (typeof config.tuyaVersion == "number" && config.tuyaVersion <= 0) ||
      isNaN(config.tuyaVersion)
        ? "3.1"
        : config.tuyaVersion.trim();

    this.deviceStatus = CLIENT_STATUS.DISCONNECTED;
    // Variable definition ends here

    if (this.eventMode == "event-data") {
      shouldSubscribeData = true;
      shouldSubscribeRefreshData = false;
    } else if (this.eventMode == "event-dp-refresh") {
      shouldSubscribeData = false;
      shouldSubscribeRefreshData = true;
    } else {
      // both case or default case
      shouldSubscribeData = true;
      shouldSubscribeRefreshData = true;
    }
    node.log(
      `Event subscription : shouldSubscribeData=>${shouldSubscribeData} , shouldSubscribeRefreshData=>${shouldSubscribeRefreshData}`
    );
    if (this.retryTimeout <= 0) {
      this.retryTimeout = 1000;
    }

    if (this.findTimeout <= 0) {
      this.findTimeout = 1000;
    }
    let findTimeoutHandler = null;
    let retryTimerHandler = null;

    this.deviceKey = config.deviceKey;
    node.on("input", function (msg) {
      node.log(`Recieved input : ${JSON.stringify(msg)}`);
      let operation = msg.payload.operation || "SET";
      delete msg.payload.operation;
      switch (operation) {
        case "SET":
          tuyaDevice.set(msg.payload);
          break;
        case "REFRESH":
          tuyaDevice.refresh(msg.payload);
          break;
        case "GET":
          tuyaDevice.get(msg.payload);
          break;
        case "CONTROL":
          if (msg.payload.action == "CONNECT") {
            startComm();
          } else if (msg.payload.action == "DISCONNECT") {
            closeComm();
          } else if (msg.payload.action == "SET_FIND_TIMEOUT") {
            setFindTimeout(msg.payload.value);
          } else if (msg.payload.action == "SET_RETRY_TIMEOUT") {
            setRetryTimeout(msg.payload.value);
          } else if (msg.payload.action == "RECONNECT") {
            startComm();
          }
          break;
      }
    });
    const enableNode = () => {
      console.log("enabling the node", node.id);
      startComm();
    };

    const disableNode = () => {
      console.log("disabling the node", node.id);
      closeComm();
    };

    const setFindTimeout = (newTimeout) => {
      node.log("Setting new find timeout :" + newTimeout);
      node.findTimeout = newTimeout;
    };

    const setRetryTimeout = (newTimeout) => {
      node.log("Setting new retry timeout :" + newTimeout);
      node.retryTimeout = newTimeout;
    };

    const closeComm = () => {
      node.log("Cleaning up the state");
      clearTimeout(findTimeoutHandler);
      shouldTryReconnect = false;
      tuyaDevice.disconnect();
      node.log("Clearing the find timeout handler");
      setStatusDisconnected();
    };

    const startComm = () => {
      closeComm();
      findTimeoutHandler = setTimeout(() => {
        shouldTryReconnect = true;
        node.log(
          `Connecting to Tuya with params ${JSON.stringify(
            connectionParams
          )} , findTimeout :  ${node.findTimeout} , retryTimeout:  ${
            node.retryTimeout
          } `
        );
        findDevice();
      }, 1000);
    };

    const sendDeviceConnectStatus = (data) => {
      return {
        payload: {
          state: node.deviceStatus,
          ...data,
        },
      };
    };
    const setStatusConnecting = function () {
      node.deviceStatus = CLIENT_STATUS.CONNECTING;
      node.send([null, sendDeviceConnectStatus()]);
      return node.status({ fill: "yellow", shape: "ring", text: "connecting" });
    };
    const setStatusConnected = function () {
      node.deviceStatus = CLIENT_STATUS.CONNECTED;
      node.send([null, sendDeviceConnectStatus()]);
      return node.status({ fill: "green", shape: "ring", text: "connected" });
    };
    const setStatusDisconnected = function () {
      node.deviceStatus = CLIENT_STATUS.DISCONNECTED;
      node.send([null, sendDeviceConnectStatus()]);
      return node.status({ fill: "red", shape: "ring", text: "disconnected" });
    };
    const setStatusOnError = function (
      errorText,
      errorShortText = "error",
      data
    ) {
      node.deviceStatus = CLIENT_STATUS.ERROR;
      node.error(errorText, data);
      node.send([null, sendDeviceConnectStatus(data)]);
      return node.status({ fill: "red", shape: "ring", text: errorShortText });
    };
    const connectionParams = {
      id: node.deviceId,
      key: node.deviceKey,
      ip: node.deviceIp,
      issueGetOnConnect: false,
      nullPayloadOnJSONError: false,
      version: node.tuyaVersion,
    };

    let tuyaDevice = new TuyaDevice(connectionParams);

    let retryConnection = () => {
      clearTimeout(retryTimerHandler);
      retryTimerHandler = setTimeout(() => {
        connectDevice();
      }, node.retryTimeout);
    };
    node.on("close", function () {
      // tidy up any state
      // clearInterval(int);
      closeComm();
    });

    // Add event listeners
    tuyaDevice.on("connected", () => {
      node.log("Connected to device! " + node.deviceId);
      setStatusConnected();
    });

    tuyaDevice.on("disconnected", () => {
      node.log("Disconnected from tuyaDevice.");
      setStatusDisconnected();
      if (shouldTryReconnect) {
        retryConnection();
      }
    });

    tuyaDevice.on("error", (error) => {
      setStatusOnError(error, "Error", {
        context: {
          message: error,
          deviceVirtualId: node.deviceId,
          deviceIp: node.deviceIp,
          deviceKey: node.deviceKey,
        },
      });
      if (shouldTryReconnect) {
        retryConnection();
      }
    });

    if (shouldSubscribeRefreshData) {
      tuyaDevice.on("dp-refresh", (data) => {
        node.log(
          `Data from device  [event:dp-refresh]: ${JSON.stringify(data)}`
        );
        setStatusConnected();
        node.send([
          {
            payload: {
              data: data,
              deviceId: node.deviceId,
              deviceName: node.deviceName,
            },
          },
          null,
        ]);
      });
    }

    if (shouldSubscribeData) {
      tuyaDevice.on("data", (data) => {
        node.log(`Data from device  [event:data]: ${JSON.stringify(data)}`);
        setStatusConnected();
        node.send([
          {
            payload: {
              data: data,
              deviceId: node.deviceId,
              deviceName: node.deviceName,
            },
          },
          null,
        ]);
      });
    }
    let connectDevice = () => {
      clearTimeout(findTimeoutHandler);
      if (tuyaDevice.isConnected() === false) {
        setStatusConnecting();
        tuyaDevice.connect();
      } else {
        node.log("already connected. skippig the connect call");
        setStatusConnected();
      }
    };
    let findDevice = () => {
      setStatusConnecting();
      node.log("Initiating the find command");
      tuyaDevice
        .find()
        .then(() => {
          // Connect to device
          connectDevice();
        })
        .catch((e) => {
          // We need to retry
          setStatusOnError(e.message, "Can't find device", {
            context: {
              message: e,
              deviceVirtualId: node.deviceId,
              deviceIp: node.deviceIp,
              deviceKey: node.deviceKey,
            },
          });
          if (shouldTryReconnect) {
            node.log("Cannot find the device, re-trying...");
            findTimeoutHandler = setTimeout(findDevice, node.findTimeout);
          } else {
            node.log("not retrying the find as shouldTryReconnect = false");
          }
        });
    };
    // Start probing
    if (!node.disableAutoStart) {
      node.log("Auto start probe on connect...");
      startComm();
    } else {
      node.log("Auto start probe is disabled ");
      setTimeout(() => {
        setStatusDisconnected();
      }, 1000);
    }
  }
  RED.nodes.registerType("tuya-smart-device", TuyaSmartDeviceNode);
};
