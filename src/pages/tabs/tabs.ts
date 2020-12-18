import { HttpClient } from '@angular/common/http';
import { Component, NgZone, ViewChild } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Events, Platform } from 'ionic-angular';

import { AppProvider } from '../../providers/app/app';
import { BwcErrorProvider } from '../../providers/bwc-error/bwc-error';
import { ConfigProvider } from '../../providers/config/config';
import { Logger } from '../../providers/logger/logger';
import { PersistenceProvider } from '../../providers/persistence/persistence';
import { PlatformProvider } from '../../providers/platform/platform';
import { ProfileProvider } from '../../providers/profile/profile';
import { RateProvider } from '../../providers/rate/rate';
import { TabProvider } from '../../providers/tab/tab';
import { WalletProvider } from '../../providers/wallet/wallet';

import { CardsPage } from '../cards/cards';
import { HomePage } from '../home/home';
import { ScanPage } from '../scan/scan';
import { SettingsPage } from '../settings/settings';
import { WalletsPage } from '../wallets/wallets';

import * as _ from 'lodash';
import { Subscription } from 'rxjs';

@Component({
  templateUrl: 'tabs.html'
})
export class TabsPage {
  appName: string;
  @ViewChild('tabs')
  tabs;

  public txpsN: number;
  public cardNotificationBadgeText;
  public scanIconType: string;
  private zone;

  private onResumeSubscription: Subscription;
  private onPauseSubscription: Subscription;

  constructor(
    private plt: Platform,
    private appProvider: AppProvider,
    private profileProvider: ProfileProvider,
    private logger: Logger,
    private walletProvider: WalletProvider,
    private events: Events,
    private persistenceProvider: PersistenceProvider,
    private translate: TranslateService,
    private bwcErrorProvider: BwcErrorProvider,
    private tabProvider: TabProvider,
    private rateProvider: RateProvider,
    private platformProvider: PlatformProvider,
    private configProvider: ConfigProvider,
    private http: HttpClient
  ) {
    this.zone = new NgZone({ enableLongStackTrace: false });
    this.logger.info('Loaded: TabsPage');
    this.appName = this.appProvider.info.nameCase;
    this.scanIconType =
      this.appName == 'BitPay' ? 'tab-scan' : 'tab-copay-scan';

    if (this.platformProvider.isElectron) {
      this.updateDesktopOnFocus();
    }

    const subscribeEvents = () => {
      this.events.subscribe('experimentUpdateStart', () => {
        this.tabs.select(2);
      });
      this.events.subscribe('bwsEvent', this.bwsEventHandler);
      this.events.subscribe('Local/UpdateTxps', data => {
        this.setTxps(data);
      });
      this.events.subscribe('Local/FetchWallets', () => {
        this.fetchAllWalletsStatus();
      });
    };

    subscribeEvents();
    this.onResumeSubscription = this.plt.resume.subscribe(() => {
      subscribeEvents();
      setTimeout(() => {
        this.updateTxps();
        this.fetchAllWalletsStatus();
      }, 1000);
    });

    this.onPauseSubscription = this.plt.pause.subscribe(() => {
      this.events.unsubscribe('bwsEvent');
      this.events.unsubscribe('Local/UpdateTxps');
      this.events.unsubscribe('Local/FetchWallets');
      this.events.unsubscribe('experimentUpdateStart');
    });

    this.persistenceProvider.getCardExperimentFlag().then(status => {
      if (status === 'enabled') {
        this.persistenceProvider
          .getCardNotificationBadge()
          .then(badgeStatus => {
            this.cardNotificationBadgeText =
              badgeStatus === 'disabled' ? null : 'New';
          });
      }
    });
  }

  ngOnInit() {
    this.tabProvider.prefetchCards().then(async data => {
      let cardExperimentEnabled;
      try {
        this.logger.debug('BitPay: setting country');
        const { country } = await this.http
          .get<{ country: string }>('https://bitpay.com/wallet-card/location')
          .toPromise();
        if (country === 'US') {
          this.logger.debug('If US: Set Card Experiment Flag Enabled');
          await this.persistenceProvider.setCardExperimentFlag('enabled');
          cardExperimentEnabled = true;
        }
      } catch (err) {
        this.logger.error('Error setting country: ', err);
      }
      // [0] BitPay Cards
      // [1] Gift Cards
      this.events.publish('Local/FetchCards', {
        bpCards: data[0],
        cardExperimentEnabled
      });
    });
  }

  ngOnDestroy() {
    this.onResumeSubscription.unsubscribe();
    this.onPauseSubscription.unsubscribe();
  }

  disableCardNotificationBadge() {
    this.persistenceProvider.getCardExperimentFlag().then(status => {
      if (status === 'enabled') {
        this.cardNotificationBadgeText = null;
        this.persistenceProvider.setCardNotificationBadge('disabled');
      }
    });
  }

  updateTxps() {
    this.profileProvider.getTxps({ limit: 3 }).then(data => {
      this.setTxps(data);
    });
  }

  setTxps(data) {
    this.zone.run(() => {
      this.txpsN = data.n;
    });
  }

  private updateDesktopOnFocus() {
    const { remote } = (window as any).require('electron');
    const win = remote.getCurrentWindow();
    win.on('focus', () => {
      setTimeout(() => {
        this.updateTxps();
        this.fetchAllWalletsStatus();
      }, 1000);
    });
  }

  private bwsEventHandler: any = (walletId: string, type: string) => {
    _.each(
      [
        'TxProposalRejectedBy',
        'TxProposalAcceptedBy',
        'transactionProposalRemoved',
        'TxProposalRemoved',
        'NewOutgoingTx',
        'UpdateTx',
        'NewIncomingTx'
      ],
      (eventName: string) => {
        if (
          walletId &&
          type == eventName &&
          (type === 'NewIncomingTx' || type === 'NewOutgoingTx')
        ) {
          this.fetchAllWalletsStatus();
        }
      }
    );
  };

  private updateTotalBalance(wallets) {
    this.rateProvider.getLastDayRates().then(lastDayRatesArray => {
      this.walletProvider
        .getTotalAmount(wallets, lastDayRatesArray)
        .then(data => {
          this.logger.debug('Total Balance and Price Updated');
          this.events.publish('Local/HomeBalance', data);
          this.events.publish('Local/PriceUpdate');
        });
    });
  }

  private processWalletError(wallet, err): void {
    wallet.error = wallet.errorObj = null;

    if (!err || err == 'INPROGRESS') return;

    wallet.cachedStatus = null;
    wallet.errorObj = err;

    if (err.message === '403') {
      this.events.publish('Local/AccessDenied');
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

  private connectionError = _.debounce(
    async () => {
      this.events.publish('Local/ConnectionError');
    },
    5000,
    {
      leading: false
    }
  );

  private fetchAllWalletsStatus = _.debounce(
    async () => {
      this._fetchAllWallets();
    },
    5000,
    {
      leading: true
    }
  );

  private checkAltCurrency(): void {
    const altCurrencyIsoCode = this.configProvider.get().wallet.settings
      .alternativeIsoCode;
    if (this.rateProvider.isAltCurrencyAvailable(altCurrencyIsoCode)) return;

    const defaults = this.configProvider.getDefaults();
    var opts = {
      wallet: {
        settings: {
          alternativeName: defaults.wallet.settings.alternativeName,
          alternativeIsoCode: defaults.wallet.settings.alternativeIsoCode
        }
      }
    };
    this.configProvider.set(opts);
  }

  private _fetchAllWallets() {
    let hasConnectionError: boolean = false;
    // Set the default alternative currency if the one setted is no longer supported
    this.checkAltCurrency();

    this.profileProvider.setLastKnownBalance();

    let wallets = this.profileProvider.wallet;
    if (_.isEmpty(wallets)) {
      this.events.publish('Local/HomeBalance');
      return;
    }

    this.logger.debug('Fetching All Wallets and Updating Total Balance');
    wallets = _.filter(this.profileProvider.wallet, w => {
      return !w.hidden;
    });

    let foundMessage = false;

    const pr = wallet => {
      return this.walletProvider
        .fetchStatus(wallet, {})
        .then(st => {
          wallet.cachedStatus = st;
          wallet.error = wallet.errorObj = null;
          const balance =
            wallet.coin === 'xrp'
              ? wallet.cachedStatus.availableBalanceStr
              : wallet.cachedStatus.totalBalanceStr;

          this.persistenceProvider.setLastKnownBalance(wallet.id, balance);

          this.events.publish('Local/WalletUpdate', {
            walletId: wallet.id,
            finished: true
          });

          if (!foundMessage && !_.isEmpty(st.serverMessages)) {
            foundMessage = true;
            this.events.publish('Local/ServerMessage', {
              serverMessages: st.serverMessages
            });
          }

          return Promise.resolve();
        })
        .catch(err => {
          this.processWalletError(wallet, err);
          if (err && err.message == 'Wallet service connection error.') {
            hasConnectionError = true;
            this.connectionError();
          }
          return Promise.resolve();
        });
    };

    const promises = [];

    _.each(wallets, wallet => {
      promises.push(pr(wallet));
    });

    Promise.all(promises).then(() => {
      if (!hasConnectionError) this.updateTotalBalance(wallets);
      this.updateTxps();
    });
  }

  homeRoot = HomePage;
  walletsRoot = WalletsPage;
  scanRoot = ScanPage;
  cardsRoot = CardsPage;
  settingsRoot = SettingsPage;
}
