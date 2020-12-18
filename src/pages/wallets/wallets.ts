import { Component, NgZone, ViewChild } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import {
  Events,
  ModalController,
  NavController,
  Platform
} from 'ionic-angular';
import * as _ from 'lodash';
import { Subscription } from 'rxjs';

// Pages
import { AddPage } from '../add/add';
import { CopayersPage } from '../add/copayers/copayers';
import { BackupKeyPage } from '../backup/backup-key/backup-key';
import { CoinbaseAccountPage } from '../integrations/coinbase/coinbase-account/coinbase-account';
import { SettingsPage } from '../settings/settings';
import { WalletDetailsPage } from '../wallet-details/wallet-details';
import { ProposalsNotificationsPage } from './proposals-notifications/proposals-notifications';

// Providers
import { ActionSheetProvider } from '../../providers/action-sheet/action-sheet';
import { BwcErrorProvider } from '../../providers/bwc-error/bwc-error';
import { ClipboardProvider } from '../../providers/clipboard/clipboard';
import { CoinbaseProvider } from '../../providers/coinbase/coinbase';
import { EmailNotificationsProvider } from '../../providers/email-notifications/email-notifications';
import { HomeIntegrationsProvider } from '../../providers/home-integrations/home-integrations';
import { IncomingDataProvider } from '../../providers/incoming-data/incoming-data';
import { Logger } from '../../providers/logger/logger';
import { PayproProvider } from '../../providers/paypro/paypro';
import { PersistenceProvider } from '../../providers/persistence/persistence';
import { PlatformProvider } from '../../providers/platform/platform';
import { PopupProvider } from '../../providers/popup/popup';
import { ProfileProvider } from '../../providers/profile/profile';
import { WalletProvider } from '../../providers/wallet/wallet';

interface UpdateWalletOptsI {
  walletId: string;
  force?: boolean;
  alsoUpdateHistory?: boolean;
}

@Component({
  selector: 'page-wallets',
  templateUrl: 'wallets.html'
})
export class WalletsPage {
  @ViewChild('priceCard')
  priceCard;
  public wallets;
  public walletsGroups;
  public txpsN: number;
  public validDataFromClipboard = null;
  public payProDetailsData;
  public remainingTimeStr: string;

  public collapsedGroups;

  private zone;
  private countDown;
  private onResumeSubscription: Subscription;
  private onPauseSubscription: Subscription;

  public showCoinbase: boolean;
  public coinbaseLinked: boolean;
  public coinbaseData: object = {};

  constructor(
    private plt: Platform,
    private navCtrl: NavController,
    private profileProvider: ProfileProvider,
    private walletProvider: WalletProvider,
    private bwcErrorProvider: BwcErrorProvider,
    private logger: Logger,
    private events: Events,
    private popupProvider: PopupProvider,
    private platformProvider: PlatformProvider,
    private homeIntegrationsProvider: HomeIntegrationsProvider,
    private payproProvider: PayproProvider,
    private persistenceProvider: PersistenceProvider,
    private translate: TranslateService,
    private emailProvider: EmailNotificationsProvider,
    private clipboardProvider: ClipboardProvider,
    private incomingDataProvider: IncomingDataProvider,
    private modalCtrl: ModalController,
    private actionSheetProvider: ActionSheetProvider,
    private coinbaseProvider: CoinbaseProvider
  ) {
    this.collapsedGroups = {};
    // Update Wallet on Focus
    if (this.platformProvider.isElectron) {
      this.updateDesktopOnFocus();
    }
    this.zone = new NgZone({ enableLongStackTrace: false });
  }

  ionViewDidEnter() {
    this._didEnter();
  }

  ionViewWillEnter() {
    this.walletsGroups = this.profileProvider.orderedWalletsByGroup;

    // Get Coinbase Accounts and UserInfo
    this.setCoinbase();
  }

  private setCoinbase(force?) {
    this.showCoinbase = this.homeIntegrationsProvider.shouldShowInHome(
      'coinbase'
    );
    if (!this.showCoinbase) return;
    this.coinbaseLinked = this.coinbaseProvider.isLinked();
    if (this.coinbaseLinked) {
      if (force || _.isEmpty(this.coinbaseData)) {
        this.zone.run(() => {
          this.coinbaseProvider.preFetchAllData(this.coinbaseData);
        });
      } else this.coinbaseData = this.coinbaseProvider.coinbaseData;
    }
  }

  private _didEnter() {
    this.checkClipboard();
    this.updateTxps();
  }

  private walletFocusHandler = opts => {
    this.logger.debug('RECV Local/WalletFocus @home', opts);
    opts = opts || {};
    opts.alsoUpdateHistory = true;
    this.fetchWalletStatus(opts);
  };

  private walletActionHandler = opts => {
    this.logger.debug('RECV Local/TxAction @home', opts);
    opts = opts || {};
    opts.alsoUpdateHistory = true;
    this.fetchWalletStatus(opts);
  };

  ionViewDidLoad() {
    this.logger.info('Loaded: WalletsPage');

    // Required delay to improve performance loading
    setTimeout(() => {
      this.checkEmailLawCompliance();
    }, 2000);

    const subscribeEvents = () => {
      // BWS Events: Update Status per Wallet -> Update txps
      // NewBlock, NewCopayer, NewAddress, NewTxProposal, TxProposalAcceptedBy, TxProposalRejectedBy, txProposalFinallyRejected,
      // txProposalFinallyAccepted, TxProposalRemoved, NewIncomingTx, NewOutgoingTx
      this.events.subscribe('bwsEvent', this.bwsEventHandler);

      // Reject, Remove, OnlyPublish and SignAndBroadcast -> Update Status per Wallet -> Update txps
      this.events.subscribe('Local/TxAction', this.walletActionHandler);

      // Wallet is focused on some inner view, therefore, we refresh its status and txs
      this.events.subscribe('Local/WalletFocus', this.walletFocusHandler);
    };

    subscribeEvents();
    this.onResumeSubscription = this.plt.resume.subscribe(() => {
      this.checkClipboard();
      subscribeEvents();
    });

    this.onPauseSubscription = this.plt.pause.subscribe(() => {
      this.events.unsubscribe('bwsEvent', this.bwsEventHandler);
      this.events.unsubscribe('Local/TxAction', this.walletFocusHandler);
      this.events.unsubscribe('Local/WalletFocus', this.walletFocusHandler);
    });
  }

  ngOnDestroy() {
    this.onResumeSubscription.unsubscribe();
    this.onPauseSubscription.unsubscribe();
  }

  private debounceFetchWalletStatus = _.debounce(
    async (walletId, alsoUpdateHistory) => {
      this.fetchWalletStatus({ walletId, alsoUpdateHistory });
    },
    3000
  );

  // BWS events can come many at time (publish,sign, broadcast...)
  private bwsEventHandler = (walletId, type, n) => {
    // NewBlock, NewCopayer, NewAddress, NewTxProposal, TxProposalAcceptedBy, TxProposalRejectedBy, txProposalFinallyRejected,
    // txProposalFinallyAccepted, TxProposalRemoved, NewIncomingTx, NewOutgoingTx

    const wallet = this.profileProvider.getWallet(walletId);
    if (!wallet) return;
    if (wallet.copayerId == n.creatorId) return;

    this.logger.info(`BWS Event: ${type}: `, n);

    let alsoUpdateHistory = false;
    switch (type) {
      case 'NewAddress':
        this.walletProvider.expireAddress(walletId);
        return;
      case 'NewIncomingTx':
      case 'NewOutgoingTx':
      case 'NewBlock':
        alsoUpdateHistory = true;
    }
    this.walletProvider.invalidateCache(wallet);
    this.debounceFetchWalletStatus(walletId, alsoUpdateHistory);
  };

  private updateDesktopOnFocus() {
    const { remote } = (window as any).require('electron');
    const win = remote.getCurrentWindow();
    win.on('focus', () => {
      if (
        this.navCtrl.getActive() &&
        this.navCtrl.getActive().name == 'WalletsPage'
      ) {
        this.checkClipboard();
      }
    });
  }

  private openEmailDisclaimer() {
    const message = this.translate.instant(
      'By providing your email address, you give explicit consent to BitPay to use your email address to send you email notifications about payments.'
    );
    const title = this.translate.instant('Privacy Policy update');
    const okText = this.translate.instant('Accept');
    const cancelText = this.translate.instant('Disable notifications');
    this.popupProvider
      .ionicConfirm(title, message, okText, cancelText)
      .then(ok => {
        if (ok) {
          // Accept new Privacy Policy
          this.persistenceProvider.setEmailLawCompliance('accepted');
        } else {
          // Disable email notifications
          this.persistenceProvider.setEmailLawCompliance('rejected');
          this.emailProvider.updateEmail({
            enabled: false,
            email: 'null@email'
          });
        }
      });
  }

  private checkEmailLawCompliance(): void {
    setTimeout(() => {
      if (this.emailProvider.getEmailIfEnabled()) {
        this.persistenceProvider.getEmailLawCompliance().then(value => {
          if (!value) this.openEmailDisclaimer();
        });
      }
    }, 2000);
  }

  private debounceSetWallets = _.debounce(
    async () => {
      this.profileProvider.setOrderedWalletsByGroup();
      this.walletsGroups = this.profileProvider.orderedWalletsByGroup;
    },
    5000,
    {
      leading: true
    }
  );

  private debounceSetCoinbase = _.debounce(
    async () => {
      this.coinbaseProvider.updateExchangeRates();
      this.setCoinbase(true);
    },
    5000,
    {
      leading: true
    }
  );

  private checkClipboard() {
    return this.clipboardProvider
      .getData()
      .then(data => {
        if (_.isEmpty(data)) return;
        const dataFromClipboard = this.incomingDataProvider.parseData(data);
        if (!dataFromClipboard) return;
        const dataToIgnore = [
          'BitcoinAddress',
          'BitcoinCashAddress',
          'EthereumAddress',
          'PlainUrl'
        ];
        if (dataToIgnore.indexOf(dataFromClipboard.type) > -1) return;
        if (
          dataFromClipboard.type === 'PayPro' ||
          dataFromClipboard.type === 'InvoiceUri'
        ) {
          const invoiceUrl = this.incomingDataProvider.getPayProUrl(data);
          this.payproProvider
            .getPayProOptions(invoiceUrl, true)
            .then(payproOptions => {
              if (!payproOptions) return;
              const { expires, paymentOptions, payProUrl } = payproOptions;
              let selected = paymentOptions.filter(option => option.selected);
              if (selected.length === 0) {
                // No Currency Selected default to BTC
                selected.push(payproOptions.paymentOptions[0]); // BTC
              }
              const [{ currency, estimatedAmount }] = selected;
              this.payProDetailsData = payproOptions;
              this.payProDetailsData.coin = currency.toLowerCase();
              this.payProDetailsData.amount = estimatedAmount;
              this.payProDetailsData.host = new URL(payProUrl).host;
              this.validDataFromClipboard = dataFromClipboard;
              this.clearCountDownInterval();
              this.paymentTimeControl(expires);
            })
            .catch(err => {
              this.hideClipboardCard();
              this.payProDetailsData = {};
              this.payProDetailsData.error = this.bwcErrorProvider.msg(err);
              this.logger.warn(
                'Error fetching this invoice',
                this.bwcErrorProvider.msg(err)
              );
            });
        }
      })
      .catch(err => {
        this.logger.warn('Paste from clipboard: ', err);
      });
  }

  public hideClipboardCard() {
    this.validDataFromClipboard = null;
    this.clipboardProvider.clear();
  }

  public processClipboardData(data): void {
    this.clearCountDownInterval();
    this.hideClipboardCard();
    this.incomingDataProvider.redir(data, { fromHomeCard: true });
  }

  private clearCountDownInterval(): void {
    if (this.countDown) clearInterval(this.countDown);
  }

  private paymentTimeControl(expires): void {
    const expirationTime = Math.floor(new Date(expires).getTime() / 1000);
    const setExpirationTime = (): void => {
      const now = Math.floor(Date.now() / 1000);
      if (now > expirationTime) {
        this.remainingTimeStr = this.translate.instant('Expired');
        this.clearCountDownInterval();
        return;
      }
      const totalSecs = expirationTime - now;
      const m = Math.floor(totalSecs / 60);
      const s = totalSecs % 60;
      this.remainingTimeStr = ('0' + m).slice(-2) + ':' + ('0' + s).slice(-2);
    };

    setExpirationTime();

    this.countDown = setInterval(() => {
      setExpirationTime();
    }, 1000);
  }

  private fetchTxHistory(opts: UpdateWalletOptsI) {
    if (!opts.walletId) {
      this.logger.error('Error no walletId in update History');
      return;
    }
    const wallet = this.profileProvider.getWallet(opts.walletId);

    const progressFn = ((_, newTxs) => {
      let args = {
        walletId: opts.walletId,
        finished: false,
        progress: newTxs
      };
      this.events.publish('Local/WalletHistoryUpdate', args);
    }).bind(this);

    // Fire a startup event, to allow UI to show the spinner
    this.events.publish('Local/WalletHistoryUpdate', {
      walletId: opts.walletId,
      finished: false
    });
    this.walletProvider
      .fetchTxHistory(wallet, progressFn, opts)
      .then(txHistory => {
        wallet.completeHistory = txHistory;
        this.events.publish('Local/WalletHistoryUpdate', {
          walletId: opts.walletId,
          finished: true
        });
      })
      .catch(err => {
        if (err != 'HISTORY_IN_PROGRESS') {
          this.logger.warn('WalletHistoryUpdate ERROR', err);
          this.events.publish('Local/WalletHistoryUpdate', {
            walletId: opts.walletId,
            finished: false,
            error: err
          });
        }
      });
  }

  // Names:
  // .fetch => from BWS
  // .update => to UI
  /* This is the only .getStatus call in Copay */
  private fetchWalletStatus = (opts: UpdateWalletOptsI): void => {
    if (!opts.walletId) {
      this.logger.error('Error no walletId in update Wallet');
      return;
    }
    this.events.publish('Local/WalletUpdate', {
      walletId: opts.walletId,
      finished: false
    });

    this.logger.debug(
      'fetching status for: ' +
        opts.walletId +
        ' alsohistory:' +
        opts.alsoUpdateHistory
    );
    const wallet = this.profileProvider.getWallet(opts.walletId);
    if (!wallet) return;

    this.walletProvider
      .fetchStatus(wallet, opts)
      .then(status => {
        wallet.cachedStatus = status;
        wallet.error = wallet.errorObj = null;

        const balance =
          wallet.coin === 'xrp'
            ? wallet.cachedStatus.availableBalanceStr
            : wallet.cachedStatus.totalBalanceStr;

        this.persistenceProvider.setLastKnownBalance(wallet.id, balance);

        // Update txps
        this.updateTxps();
        this.events.publish('Local/WalletUpdate', {
          walletId: opts.walletId,
          finished: true
        });

        if (opts.alsoUpdateHistory) {
          this.fetchTxHistory({ walletId: opts.walletId, force: opts.force });
        }
      })
      .catch(err => {
        if (err == 'INPROGRESS') return;

        this.logger.warn('Update error:', err);

        this.processWalletError(wallet, err);

        this.events.publish('Local/WalletUpdate', {
          walletId: opts.walletId,
          finished: true,
          error: wallet.error
        });

        if (opts.alsoUpdateHistory) {
          this.fetchTxHistory({ walletId: opts.walletId, force: opts.force });
        }
      });
  };

  private updateTxps() {
    this.profileProvider
      .getTxps({ limit: 3 })
      .then(data => {
        this.events.publish('Local/UpdateTxps', {
          n: data.n
        });
        this.zone.run(() => {
          this.txpsN = data.n;
        });
      })
      .catch(err => {
        this.logger.error(err);
      });
  }

  private processWalletError(wallet, err): void {
    wallet.error = wallet.errorObj = null;

    if (!err || err == 'INPROGRESS') return;

    wallet.cachedStatus = null;
    wallet.errorObj = err;

    if (err.message === '403') {
      wallet.error = this.translate.instant('Access denied');
    } else if (err === 'WALLET_NOT_REGISTERED') {
      wallet.error = this.translate.instant('Wallet not registered');
    } else {
      wallet.error = this.bwcErrorProvider.msg(err);
    }
    this.logger.warn(
      this.bwcErrorProvider.msg(
        wallet.error,
        'Error updating status for ' + wallet.id
      )
    );
  }

  public goToWalletDetails(wallet): void {
    if (wallet.isComplete()) {
      this.navCtrl.push(WalletDetailsPage, {
        walletId: wallet.credentials.walletId
      });
    } else {
      const copayerModal = this.modalCtrl.create(
        CopayersPage,
        {
          walletId: wallet.credentials.walletId
        },
        {
          cssClass: 'wallet-details-modal'
        }
      );
      copayerModal.present();
    }
  }

  public openProposalsNotificationsPage(): void {
    this.navCtrl.push(ProposalsNotificationsPage);
  }

  public doRefresh(refresher): void {
    this.debounceSetWallets();
    this.debounceSetCoinbase();
    setTimeout(() => {
      refresher.complete();
    }, 2000);
  }

  public settings(): void {
    this.navCtrl.push(SettingsPage);
  }

  public collapseGroup(keyId: string) {
    this.collapsedGroups[keyId] = this.collapsedGroups[keyId] ? false : true;
  }

  public isCollapsed(keyId: string): boolean {
    return this.collapsedGroups[keyId] ? true : false;
  }

  public addWallet(keyId): void {
    this.navCtrl.push(AddPage, {
      keyId
    });
  }

  public openBackupPage(keyId) {
    this.navCtrl.push(BackupKeyPage, {
      keyId
    });
  }

  public showMoreOptions(): void {
    const walletTabOptionsAction = this.actionSheetProvider.createWalletTabOptions(
      { walletsGroups: this.walletsGroups }
    );
    walletTabOptionsAction.present();
    walletTabOptionsAction.onDidDismiss(data => {
      if (data)
        data.keyId
          ? this.addWallet(data.keyId)
          : this.navCtrl.push(AddPage, {
              isZeroState: true
            });
    });
  }

  public getNativeBalance(amount, currency): string {
    return this.coinbaseProvider.getNativeCurrencyBalance(amount, currency);
  }

  public goToCoinbaseAccount(id): void {
    this.navCtrl.push(CoinbaseAccountPage, {
      id
    });
  }
}
