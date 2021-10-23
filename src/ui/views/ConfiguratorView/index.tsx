import React, {
  FunctionComponent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  AlertTitle,
  Button,
  Card,
  CardContent,
  Container,
  Divider,
  makeStyles,
  Snackbar,
  Tooltip,
} from '@material-ui/core';
import SettingsIcon from '@material-ui/icons/Settings';
import { ipcRenderer } from 'electron';
import Header from '../../components/Header';
import FirmwareVersionForm from '../../components/FirmwareVersionForm';
import DeviceTargetForm from '../../components/DeviceTargetForm';
import DeviceOptionsForm, {
  DeviceOptionsFormData,
} from '../../components/DeviceOptionsForm';
import Sidebar from '../../components/Sidebar';
import ShowAlerts from '../../components/ShowAlerts';
import CardTitle from '../../components/CardTitle';
import EventsBatcher from '../../library/EventsBatcher';
import Logs from '../../components/Logs';
import BuildProgressBar from '../../components/BuildProgressBar';
import BuildNotificationsList from '../../components/BuildNotificationsList';
import {
  BuildFlashFirmwareInput,
  BuildJobType,
  BuildProgressNotification,
  FirmwareSource,
  FirmwareVersionDataInput,
  useBuildFlashFirmwareMutation,
  useBuildLogUpdatesSubscription,
  useBuildProgressNotificationsSubscription,
  UserDefinesMode,
  useTargetDeviceOptionsLazyQuery,
  useAvailableFirmwareTargetsLazyQuery,
  Device,
  useMulticastDnsMonitorUpdatesSubscription,
  MulticastDnsInformation,
  MulticastDnsEventType,
  Target,
  FlashingMethod,
  useAvailableMulticastDnsDevicesListQuery,
} from '../../gql/generated/types';
import Loader from '../../components/Loader';
import BuildResponse from '../../components/BuildResponse';
import {
  IpcRequest,
  OpenFileLocationRequestBody,
  UpdateBuildStatusRequestBody,
} from '../../../ipc';
import UserDefinesValidator from './UserDefinesValidator';
import ApplicationStorage from '../../storage';
import persistDeviceOptions from '../../storage/commands/persistDeviceOptions';
import mergeWithDeviceOptionsFromStorage from '../../storage/commands/mergeWithDeviceOptionsFromStorage';
import UserDefinesAdvisor from '../../components/UserDefinesAdvisor';
import SerialDeviceSelect from '../../components/SerialDeviceSelect';
import WifiDeviceSelect from '../../components/WifiDeviceSelect';
import WifiDeviceList from '../../components/WifiDeviceList';
import GitRepository from '../../models/GitRepository';

export const validateFirmwareVersionData = (
  data: FirmwareVersionDataInput
): Error[] => {
  const errors: Error[] = [];
  switch (data.source) {
    case FirmwareSource.Local:
      if (!(data.localPath && data.localPath.length > 0)) {
        errors.push(new Error('Local path is empty'));
      }
      break;
    case FirmwareSource.GitCommit:
      if (!(data.gitCommit && data.gitCommit.length > 0)) {
        errors.push(new Error('Git commit hash is empty'));
      }
      break;
    case FirmwareSource.GitBranch:
      if (!(data.gitBranch && data.gitBranch.length > 0)) {
        errors.push(new Error('Git branch is not selected'));
      }
      break;
    case FirmwareSource.GitTag:
      if (!(data.gitTag && data.gitTag.length > 0)) {
        errors.push(new Error('Firmware release is not selected'));
      }
      break;
    case FirmwareSource.GitPullRequest:
      if (
        !(data.gitPullRequest && data.gitPullRequest.headCommitHash.length > 0)
      ) {
        errors.push(new Error('Firmware Pull Request is not selected'));
      }
      break;
    default:
      throw new Error(`unknown firmware data source: ${data.source}`);
  }
  return errors;
};

const useStyles = makeStyles((theme) => ({
  root: {
    display: 'flex',
  },
  main: {
    marginTop: theme.spacing(4),
    marginBottom: theme.spacing(4),
  },
  content: {
    flexGrow: 1,
  },
  button: {
    marginRight: `${theme.spacing(2)} !important`,
  },
  longBuildDurationWarning: {
    marginBottom: theme.spacing(1),
  },
  buildResponse: {
    marginBottom: theme.spacing(1),
  },
  tooltip: {
    paddingLeft: '1em',
    paddingRight: '1em',
    fontSize: '1.4em !important',
    '& a': {
      color: '#90caf9',
    },
  },
  section: {
    paddingTop: theme.spacing(4),
  },
}));

enum ViewState {
  Configuration = 'CONFIGURATION',
  Compiling = 'https://xkcd.com/303/',
}

interface ConfiguratorViewProps {
  gitRepo: GitRepository;
}

const ConfiguratorView: FunctionComponent<ConfiguratorViewProps> = (props) => {
  const { gitRepo } = props;

  const styles = useStyles();

  const [viewState, setViewState] = useState<ViewState>(
    ViewState.Configuration
  );

  const [progressNotifications, setProgressNotifications] = useState<
    BuildProgressNotification[]
  >([]);
  const progressNotificationsRef = useRef<BuildProgressNotification[]>([]);
  const [
    lastProgressNotification,
    setLastProgressNotification,
  ] = useState<BuildProgressNotification | null>(null);

  useBuildProgressNotificationsSubscription({
    onSubscriptionData: (options) => {
      const args = options.subscriptionData.data?.buildProgressNotifications;
      if (args !== undefined) {
        const newNotificationsList = [
          ...progressNotificationsRef.current,
          args,
        ];
        progressNotificationsRef.current = newNotificationsList;
        setProgressNotifications(newNotificationsList);
        setLastProgressNotification(args);
      }
    },
  });

  /*
    We batch log events in order to save React.js state updates and rendering performance.
   */
  const [logs, setLogs] = useState<string>('');
  const logsRef = useRef<string[]>([]);
  const eventsBatcherRef = useRef<EventsBatcher<string> | null>(null);
  useEffect(() => {
    eventsBatcherRef.current = new EventsBatcher<string>(200);
    eventsBatcherRef.current.onBatch((newLogs) => {
      const newLogsList = [...logsRef.current, ...newLogs];
      logsRef.current = newLogsList;
      setLogs(newLogsList.join(''));
    });
  }, []);
  useBuildLogUpdatesSubscription({
    fetchPolicy: 'network-only',
    onSubscriptionData: (options) => {
      const args = options.subscriptionData.data?.buildLogUpdates.data;
      if (args !== undefined && eventsBatcherRef.current !== null) {
        eventsBatcherRef.current.enqueue(args);
      }
    },
  });

  const [multicastDnsDevices, setMulticastDnsDevices] = useState<{
    [name: string]: MulticastDnsInformation;
  }>({});

  const {
    loading: multicastDnsDevicesListLoading,
    data: multicastDnsDevicesListData,
    error: multicastDnsDevicesListError,
  } = useAvailableMulticastDnsDevicesListQuery({
    fetchPolicy: 'network-only',
  });

  useEffect(() => {
    if (multicastDnsDevicesListData) {
      multicastDnsDevicesListData.availableMulticastDnsDevicesList.forEach(
        (item) => {
          multicastDnsDevices[item.name] = item;
        }
      );
    }
  }, [multicastDnsDevicesListData]);

  const [multicastDnsNewDevices, setMulticastDnsNewDevices] = useState<
    MulticastDnsInformation[]
  >([]);

  useMulticastDnsMonitorUpdatesSubscription({
    fetchPolicy: 'network-only',
    onSubscriptionData: (options) => {
      const data = options.subscriptionData.data?.multicastDnsMonitorUpdates;
      if (data) {
        const multicastDnsDevicesCopy = { ...multicastDnsDevices };

        if (data?.type === MulticastDnsEventType.DeviceAdded) {
          multicastDnsDevicesCopy[data.data.name] = data.data;

          const newDevices = multicastDnsNewDevices.map((item) => item);
          newDevices.push(data.data);
          setMulticastDnsNewDevices(newDevices);
        } else if (data?.type === MulticastDnsEventType.DeviceUpdated) {
          multicastDnsDevicesCopy[data.data.name] = data.data;
        } else if (data?.type === MulticastDnsEventType.DeviceRemoved) {
          delete multicastDnsDevicesCopy[data.data.name];
        }

        setMulticastDnsDevices(multicastDnsDevicesCopy);
      }
    },
  });

  const [
    firmwareVersionData,
    setFirmwareVersionData,
  ] = useState<FirmwareVersionDataInput | null>(null);
  const [firmwareVersionErrors, setFirmwareVersionErrors] = useState<Error[]>(
    []
  );
  const onFirmwareVersionData = useCallback(
    (data: FirmwareVersionDataInput) => {
      setFirmwareVersionErrors([]);
      setFirmwareVersionData(data);
    },
    []
  );

  const [deviceTarget, setDeviceTarget] = useState<string | null>(null);
  const [deviceTargetErrors, setDeviceTargetErrors] = useState<Error[]>([]);

  const onDeviceTarget = useCallback((data: string | null) => {
    setDeviceTargetErrors([]);
    setDeviceTarget(data);
  }, []);

  const [deviceTargets, setDeviceTargets] = useState<Device[] | null>(null);

  const [
    fetchDeviceTargets,
    {
      loading: loadingTargets,
      data: targetsResponse,
      error: targetsResponseError,
    },
  ] = useAvailableFirmwareTargetsLazyQuery();

  useEffect(() => {
    if (firmwareVersionData === null) {
      setDeviceTargets(null);
    } else {
      fetchDeviceTargets({
        variables: {
          source: firmwareVersionData.source as FirmwareSource,
          gitBranch: firmwareVersionData.gitBranch!,
          gitTag: firmwareVersionData.gitTag!,
          gitCommit: firmwareVersionData.gitCommit!,
          localPath: firmwareVersionData.localPath!,
          gitPullRequest: firmwareVersionData.gitPullRequest,
          gitRepo: {
            url: gitRepo.url,
            owner: gitRepo.owner,
            repositoryName: gitRepo.repositoryName,
            rawRepoUrl: gitRepo.rawRepoUrl,
            srcFolder: gitRepo.srcFolder,
          },
        },
      });
    }
  }, [firmwareVersionData]);

  useEffect(() => {
    if (targetsResponse?.availableFirmwareTargets) {
      setDeviceTargets([...targetsResponse.availableFirmwareTargets]);
    } else {
      setDeviceTargets(null);
    }
  }, [targetsResponse]);

  const [
    deviceOptionsFormData,
    setDeviceOptionsFormData,
  ] = useState<DeviceOptionsFormData>({
    userDefinesTxt: '',
    userDefinesMode: UserDefinesMode.UserInterface,
    userDefineOptions: [],
  });

  const [
    fetchOptions,
    {
      loading: loadingOptions,
      data: deviceOptionsResponse,
      error: deviceOptionsResponseError,
    },
  ] = useTargetDeviceOptionsLazyQuery();

  useEffect(() => {
    if (
      deviceTarget === null ||
      firmwareVersionData === null ||
      validateFirmwareVersionData(firmwareVersionData).length > 0
    ) {
      setDeviceOptionsFormData({
        userDefinesTxt: '',
        userDefinesMode: UserDefinesMode.UserInterface,
        userDefineOptions: [],
      });
    } else {
      fetchOptions({
        variables: {
          target: deviceTarget,
          source: firmwareVersionData.source as FirmwareSource,
          gitBranch: firmwareVersionData.gitBranch!,
          gitTag: firmwareVersionData.gitTag!,
          gitCommit: firmwareVersionData.gitCommit!,
          localPath: firmwareVersionData.localPath!,
          gitPullRequest: firmwareVersionData.gitPullRequest,
          gitRepository: {
            url: gitRepo.url,
            owner: gitRepo.owner,
            repositoryName: gitRepo.repositoryName,
            rawRepoUrl: gitRepo.rawRepoUrl,
            srcFolder: gitRepo.srcFolder,
          },
        },
      });
    }
  }, [deviceTarget, firmwareVersionData]);

  useEffect(() => {
    if (
      deviceOptionsResponse?.targetDeviceOptions?.length &&
      deviceOptionsResponse?.targetDeviceOptions?.length > 0
    ) {
      const handleUpdate = async () => {
        const storage = new ApplicationStorage();
        const deviceName =
          deviceTargets?.find((device) => {
            return device.targets.find(
              (target) => target.name === deviceTarget
            );
          })?.name || null;
        const userDefineOptions = await mergeWithDeviceOptionsFromStorage(
          storage,
          deviceName,
          {
            ...deviceOptionsFormData,
            userDefineOptions: [...deviceOptionsResponse.targetDeviceOptions],
          }
        );
        setDeviceOptionsFormData(userDefineOptions);
      };
      handleUpdate().catch((err) => {
        console.error(`failed to update device options form data: ${err}`);
      });
    }
  }, [deviceOptionsResponse, deviceTargets]);

  const onResetToDefaults = () => {
    const handleReset = async () => {
      if (deviceOptionsResponse === undefined || deviceTarget === null) {
        // eslint-disable-next-line no-alert
        alert(`deviceOptionsResponse is undefined`);
        return;
      }
      const deviceName =
        deviceTargets?.find((device) => {
          return device.targets.find((target) => target.name === deviceTarget);
        })?.name || null;
      if (deviceName) {
        const storage = new ApplicationStorage();
        await storage.removeDeviceOptions(deviceName);

        const userDefineOptions = await mergeWithDeviceOptionsFromStorage(
          storage,
          deviceName,
          {
            ...deviceOptionsFormData,
            userDefineOptions: [...deviceOptionsResponse.targetDeviceOptions],
          }
        );
        setDeviceOptionsFormData(userDefineOptions);
      }
    };
    handleReset().catch((err) => {
      console.error(`failed to reset device options form data: ${err}`);
    });
  };

  const onUserDefines = useCallback(
    (data: DeviceOptionsFormData) => {
      setDeviceOptionsFormData(data);
      if (deviceTarget !== null) {
        const storage = new ApplicationStorage();
        const deviceName = deviceTargets?.find((device) => {
          return device.targets.find((target) => target.name === deviceTarget);
        })?.name;
        if (deviceName) {
          persistDeviceOptions(storage, deviceName, data).catch((err) => {
            console.error(`failed to persist user defines: ${err}`);
          });
        }
      }
    },
    [deviceTarget, deviceTargets]
  );

  const [
    buildFlashFirmwareMutation,
    {
      loading: buildInProgress,
      data: response,
      error: buildFlashErrorResponse,
    },
  ] = useBuildFlashFirmwareMutation();

  useEffect(() => {
    const arg = response?.buildFlashFirmware?.firmwareBinPath;
    if (arg !== undefined && arg !== null && arg?.length > 0) {
      const body: OpenFileLocationRequestBody = {
        path: arg,
      };
      ipcRenderer.send(IpcRequest.OpenFileLocation, body);
    }
  }, [response]);

  const [
    longBuildDurationWarning,
    setLongBuildDurationWarning,
  ] = useState<boolean>(false);
  const buildInProgressRef = useRef(buildInProgress);
  buildInProgressRef.current = buildInProgress;
  const slowBuildTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    if (buildInProgressRef.current) {
      slowBuildTimeoutRef.current = window.setTimeout(() => {
        setLongBuildDurationWarning(true);
      }, 15 * 1000);
    } else {
      setLongBuildDurationWarning(false);
      if (slowBuildTimeoutRef.current !== null) {
        clearTimeout(slowBuildTimeoutRef.current);
      }
    }
    return () => {
      if (slowBuildTimeoutRef.current !== null) {
        clearTimeout(slowBuildTimeoutRef.current);
      }
    };
  }, [buildInProgress]);

  const [luaScriptLocation, setLuaScriptLocation] = useState<string>('');
  useEffect(() => {
    const isTX = (item: string) => {
      return item.indexOf('_TX_') > -1;
    };
    if (
      deviceTarget === null ||
      firmwareVersionData === null ||
      !isTX(deviceTarget)
    ) {
      setLuaScriptLocation('');
      return;
    }

    switch (firmwareVersionData.source) {
      case FirmwareSource.Local:
        setLuaScriptLocation('');
        break;
      case FirmwareSource.GitCommit:
        setLuaScriptLocation(
          `https://raw.githubusercontent.com/ExpressLRS/ExpressLRS/${firmwareVersionData.gitCommit}/src/lua/ELRS.lua`
        );
        break;
      case FirmwareSource.GitBranch:
        setLuaScriptLocation(
          `https://raw.githubusercontent.com/ExpressLRS/ExpressLRS/${firmwareVersionData.gitBranch}/src/lua/ELRS.lua`
        );
        break;
      case FirmwareSource.GitTag:
        setLuaScriptLocation(
          `https://raw.githubusercontent.com/ExpressLRS/ExpressLRS/${firmwareVersionData.gitTag}/src/lua/ELRS.lua`
        );
        break;
      case FirmwareSource.GitPullRequest:
        setLuaScriptLocation(
          `https://raw.githubusercontent.com/ExpressLRS/ExpressLRS/${firmwareVersionData.gitPullRequest?.headCommitHash}/src/lua/ELRS.lua`
        );
        break;
      default:
        throw new Error(
          `unknown firmware data source: ${firmwareVersionData.source}`
        );
    }
  }, [deviceTarget, firmwareVersionData]);

  /*
    Display Electron.js confirmation dialog if user wants to shutdown the app
    when build is in progress.
   */
  useEffect(() => {
    const body: UpdateBuildStatusRequestBody = {
      buildInProgress: buildInProgressRef.current,
    };
    ipcRenderer.send(IpcRequest.UpdateBuildStatus, body);
  }, [buildInProgress]);

  const [serialDevice, setSerialDevice] = useState<string | null>(null);
  const onSerialDevice = (newSerialDevice: string | null) => {
    setSerialDevice(newSerialDevice);
  };

  const [wifiDevice, setWifiDevice] = useState<string | null>(null);
  const onWifiDevice = useCallback((newWifiDevice: string | null) => {
    setWifiDevice(newWifiDevice);
  }, []);

  const [serialPortRequired, setSerialPortRequired] = useState<boolean>(false);
  const [wifiDeviceRequired, setWifiDeviceRequired] = useState<boolean>(false);

  useEffect(() => {
    let target: Target | undefined;

    deviceTargets?.forEach((device) => {
      target =
        device.targets.find((item) => item.name === deviceTarget) || target;
    });

    if (
      target &&
      (target.flashingMethod === FlashingMethod.BetaflightPassthrough ||
        target.flashingMethod === FlashingMethod.UART)
    ) {
      setSerialPortRequired(true);
    } else {
      setSerialPortRequired(false);
    }

    if (target && target.flashingMethod === FlashingMethod.WIFI) {
      setWifiDeviceRequired(true);
    } else {
      setWifiDeviceRequired(false);
    }
  }, [deviceTarget, deviceTargets]);

  const [
    deviceOptionsValidationErrors,
    setDeviceOptionsValidationErrors,
  ] = useState<Error[] | null>(null);

  const reset = () => {
    logsRef.current = [];
    progressNotificationsRef.current = [];
    setLogs('');
    setFirmwareVersionErrors([]);
    setDeviceTargetErrors([]);
    setDeviceOptionsValidationErrors([]);

    setProgressNotifications([]);
    setLastProgressNotification(null);
  };

  const onBack = () => {
    reset();
    setViewState(ViewState.Configuration);
  };

  const [currentJobType, setCurrentJobType] = useState<BuildJobType>(
    BuildJobType.Build
  );
  const sendJob = (type: BuildJobType) => {
    reset();
    setCurrentJobType(type);

    // Validate firmware source
    if (firmwareVersionData === null) {
      setFirmwareVersionErrors([new Error('Please select firmware source')]);
      return;
    }
    const sourceErrors = validateFirmwareVersionData(firmwareVersionData);
    if (sourceErrors.length > 0) {
      setFirmwareVersionErrors(sourceErrors);
      return;
    }

    // Validate device target
    if (deviceTarget === null) {
      setDeviceTargetErrors([new Error('Please select a device target')]);
      return;
    }

    // Validate device options
    if (deviceOptionsFormData === null) {
      setDeviceTargetErrors([
        new Error('Please configure your device options'),
      ]);
      return;
    }

    switch (deviceOptionsFormData.userDefinesMode) {
      case UserDefinesMode.Manual:
        break;
      case UserDefinesMode.UserInterface:
        const errs = new UserDefinesValidator().validate(
          deviceOptionsFormData.userDefineOptions
        );
        if (errs.length > 0) {
          setDeviceOptionsValidationErrors(errs);
          return;
        }
        break;
      default:
        break;
    }

    let uploadPort: string | undefined;

    if (serialPortRequired && serialDevice != null) {
      uploadPort = serialDevice;
    } else if (wifiDeviceRequired && wifiDevice !== null) {
      uploadPort = wifiDevice;
    }

    const input: BuildFlashFirmwareInput = {
      type,
      firmware: firmwareVersionData,
      target: deviceTarget,
      userDefinesTxt: deviceOptionsFormData.userDefinesTxt,
      userDefinesMode: deviceOptionsFormData.userDefinesMode,
      userDefines: deviceOptionsFormData.userDefineOptions.map((item) => ({
        key: item.key,
        value: item.value,
        enabled: item.enabled,
        enumValues: item.enumValues,
        type: item.type,
      })),
      serialDevice: uploadPort,
      gitRepository: {
        url: gitRepo.url,
        owner: gitRepo.owner,
        repositoryName: gitRepo.repositoryName,
        rawRepoUrl: gitRepo.rawRepoUrl,
        srcFolder: gitRepo.srcFolder,
      },
    };
    buildFlashFirmwareMutation({
      variables: {
        input,
      },
    });
    setViewState(ViewState.Compiling);
  };

  useEffect(() => {
    if (
      !buildInProgress &&
      response?.buildFlashFirmware?.success !== undefined
    ) {
      window.scrollTo(0, document.body.scrollHeight);
    }
  }, [buildInProgress, response]);

  const onBuild = () => sendJob(BuildJobType.Build);
  const onBuildAndFlash = () => sendJob(BuildJobType.BuildAndFlash);

  const deviceOptionsRef = useRef<HTMLDivElement | null>(null);

  const onWifiDeviceChange = useCallback(
    (deviceName: string) => {
      const dnsDevice = multicastDnsDevices[deviceName];

      const targetName = dnsDevice.target.toUpperCase();

      const device = deviceTargets?.find((item) => {
        return item.targets.find((target) => {
          return target.name.toUpperCase().startsWith(targetName);
        });
      });

      const dTarget =
        device?.targets.find((target) => {
          return target.flashingMethod === FlashingMethod.WIFI;
        })?.name ||
        device?.targets[0].name ||
        null;

      setDeviceTarget(dTarget);

      setWifiDevice(dnsDevice.ip);

      deviceOptionsRef?.current?.scrollIntoView({ behavior: 'smooth' });
    },
    [deviceTargets, multicastDnsDevices]
  );

  return (
    <main className={styles.root}>
      <Sidebar navigationEnabled={!buildInProgress} />
      <div className={styles.content}>
        <Header />
        <Container className={styles.main}>
          {viewState === ViewState.Configuration && (
            <Card>
              <CardTitle icon={<SettingsIcon />} title="Firmware version" />
              <Divider />
              <CardContent>
                <FirmwareVersionForm
                  onChange={onFirmwareVersionData}
                  data={firmwareVersionData}
                  gitRepository={gitRepo}
                />
                <ShowAlerts severity="error" messages={firmwareVersionErrors} />
              </CardContent>
              <Divider />

              <CardTitle icon={<SettingsIcon />} title="Target" />
              <Divider />
              <CardContent>
                {!loadingTargets && (
                  <DeviceTargetForm
                    currentTarget={deviceTarget}
                    onChange={onDeviceTarget}
                    targetOptions={deviceTargets}
                  />
                )}
                <Loader loading={loadingTargets} />
                {luaScriptLocation.length > 0 && (
                  <Button
                    href={luaScriptLocation}
                    target="_blank"
                    size="small"
                    download
                  >
                    Download LUA script
                  </Button>
                )}
                <ShowAlerts severity="error" messages={deviceTargetErrors} />
              </CardContent>
              <Divider />

              <CardTitle
                icon={<SettingsIcon />}
                title={
                  <div ref={deviceOptionsRef}>
                    Device options{' '}
                    {deviceOptionsFormData.userDefinesMode ===
                      UserDefinesMode.UserInterface &&
                      deviceTarget !== null &&
                      !loadingOptions && (
                        <Tooltip
                          placement="top"
                          arrow
                          title={
                            <div className={styles.tooltip}>
                              Reset device options to the recommended defaults
                              on this device target. Except for your custom
                              binding phrase.
                            </div>
                          }
                        >
                          <Button onClick={onResetToDefaults} size="small">
                            Reset
                          </Button>
                        </Tooltip>
                      )}
                  </div>
                }
              />
              <Divider />
              <CardContent>
                {!loadingOptions && (
                  <DeviceOptionsForm
                    target={deviceTarget}
                    deviceOptions={deviceOptionsFormData}
                    onChange={onUserDefines}
                  />
                )}
                <ShowAlerts
                  severity="error"
                  messages={deviceOptionsResponseError}
                />
                <ShowAlerts
                  severity="error"
                  messages={deviceOptionsValidationErrors}
                />
                <Loader loading={loadingOptions} />
              </CardContent>
              <Divider />

              <CardTitle icon={<SettingsIcon />} title="Actions" />
              <Divider />
              <CardContent>
                <UserDefinesAdvisor
                  deviceOptionsFormData={deviceOptionsFormData}
                />

                <div>
                  {serialPortRequired && (
                    <SerialDeviceSelect
                      serialDevice={serialDevice}
                      onChange={onSerialDevice}
                    />
                  )}
                  {wifiDeviceRequired && (
                    <WifiDeviceSelect
                      wifiDevice={wifiDevice}
                      wifiDevices={Object.values(multicastDnsDevices).filter(
                        (item) => {
                          return deviceTarget
                            ?.toUpperCase()
                            .startsWith(item.target.toUpperCase());
                        }
                      )}
                      onChange={onWifiDevice}
                    />
                  )}
                  <Button
                    className={styles.button}
                    size="large"
                    variant="contained"
                    onClick={onBuild}
                  >
                    Build
                  </Button>
                  <Button
                    className={styles.button}
                    size="large"
                    variant="contained"
                    onClick={onBuildAndFlash}
                  >
                    Build & Flash
                  </Button>
                </div>
              </CardContent>

              {Object.values(multicastDnsDevices).length > 0 && (
                <div className={styles.section}>
                  <Divider />
                  <CardTitle icon={<SettingsIcon />} title="Network Devices" />
                  <Divider />
                  <CardContent>
                    <div>
                      <WifiDeviceList
                        wifiDevices={Object.values(multicastDnsDevices)}
                        onChange={onWifiDeviceChange}
                      />
                    </div>
                  </CardContent>
                </div>
              )}
            </Card>
          )}

          {viewState === ViewState.Compiling && (
            <Card>
              <CardTitle icon={<SettingsIcon />} title="Build" />
              <Divider />
              <CardContent>
                <BuildProgressBar
                  inProgress={buildInProgress}
                  jobType={currentJobType}
                  progressNotification={lastProgressNotification}
                />
                <BuildNotificationsList notifications={progressNotifications} />

                <ShowAlerts
                  severity="error"
                  messages={buildFlashErrorResponse}
                />
              </CardContent>

              {logs.length > 0 && (
                <>
                  <CardTitle icon={<SettingsIcon />} title="Logs" />
                  <Divider />
                  <CardContent>
                    {longBuildDurationWarning && (
                      <div className={styles.longBuildDurationWarning}>
                        <ShowAlerts
                          severity="warning"
                          messages="Sometimes builds take at least a few minutes. It is normal, especially for the first time builds."
                        />
                      </div>
                    )}
                    <Logs data={logs} />
                  </CardContent>
                  <Divider />
                </>
              )}
              {response !== undefined && (
                <>
                  <CardTitle icon={<SettingsIcon />} title="Result" />
                  <Divider />
                  <CardContent>
                    <div className={styles.buildResponse}>
                      <BuildResponse response={response?.buildFlashFirmware} />
                    </div>
                    {response?.buildFlashFirmware?.success &&
                      currentJobType === BuildJobType.Build && (
                        <>
                          <Alert severity="info">
                            <AlertTitle>Build notice</AlertTitle>
                            Firmware binary file was opened in the file explorer
                          </Alert>
                        </>
                      )}
                  </CardContent>
                  <Divider />
                </>
              )}
              {!buildInProgress && (
                <>
                  <CardTitle icon={<SettingsIcon />} title="Actions" />
                  <Divider />
                  <CardContent>
                    <Button
                      className={styles.button}
                      color="primary"
                      size="large"
                      variant="contained"
                      onClick={onBack}
                    >
                      Back
                    </Button>

                    <Button
                      className={styles.button}
                      size="large"
                      variant="contained"
                      onClick={onBuildAndFlash}
                    >
                      Retry
                    </Button>
                  </CardContent>
                </>
              )}
            </Card>
          )}
          {multicastDnsNewDevices.map((dnsDevice) => {
            const handleClose = () => {
              setMulticastDnsNewDevices(
                multicastDnsNewDevices.filter((d) => d !== dnsDevice)
              );
            };

            return (
              <Snackbar
                key={dnsDevice.name}
                open
                autoHideDuration={6000}
                onClose={handleClose}
              >
                <Alert onClose={handleClose} severity="info">
                  New Device {dnsDevice.name} ({dnsDevice.ip})
                  <Button
                    size="small"
                    onClick={() => {
                      onWifiDeviceChange(dnsDevice.name);
                    }}
                  >
                    Select
                  </Button>
                </Alert>
              </Snackbar>
            );
          })}
        </Container>
      </div>
    </main>
  );
};

export default ConfiguratorView;
