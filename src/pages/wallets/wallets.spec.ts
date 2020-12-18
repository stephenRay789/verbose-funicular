import { async, ComponentFixture, TestBed } from '@angular/core/testing';

import { Subject } from 'rxjs';

import { TestUtils } from '../../test';

import { ClipboardProvider } from '../../providers/clipboard/clipboard';
import { IncomingDataProvider } from '../../providers/incoming-data/incoming-data';
import { WalletsPage } from './wallets';

describe('WalletsPage', () => {
  let fixture: ComponentFixture<WalletsPage>;
  let instance;
  let testBed: typeof TestBed;

  beforeEach(async(() =>
    TestUtils.configurePageTestingModule([WalletsPage]).then(testEnv => {
      fixture = testEnv.fixture;
      instance = testEnv.instance;
      testBed = testEnv.testBed;
      instance.showCard = {
        setShowRateCard: () => {}
      };
      fixture.detectChanges();
    })));
  afterEach(() => {
    spyOn(instance, 'ngOnDestroy');
    fixture.destroy();
  });

  describe('Lifecycle Hooks', () => {
    describe('ionViewWillEnter', () => {
      describe('ionViewDidEnter', () => {
        it('should check clipboard', () => {
          const spy = spyOn(instance, 'checkClipboard');
          instance.ionViewDidEnter();
          expect(spy).toHaveBeenCalled();
        });
      });

      describe('ionViewDidLoad', () => {
        beforeEach(() => {
          instance.plt.resume = new Subject();
          instance.plt.pause = new Subject();
        });
        /* it('should subscribe to events', () => {
          const subscribeSpy = spyOn(instance.events, 'subscribe');
          instance.ionViewDidLoad();
          expect(subscribeSpy).toHaveBeenCalledWith(
            'bwsEvent',
            instance.bwsEventHandler
          );
          expect(subscribeSpy).toHaveBeenCalledWith(
            'Local/WalletListChange',
            instance.setWallets
          );
          expect(subscribeSpy).toHaveBeenCalledWith(
            'Local/TxAction',
            instance.walletActionHandler
          );
          expect(subscribeSpy).toHaveBeenCalledWith(
            'Local/WalletFocus',
            instance.walletFocusHandler
          );
        });
        it('should update wallets on platform resume', () => {
          instance.ionViewDidLoad();
          const setWalletsSpy = spyOn(instance, 'setWallets');
          instance.plt.resume.next();
          expect(setWalletsSpy).toHaveBeenCalled();
        }); TODO */
      });
    });
  });

  describe('Methods', () => {
    describe('checkClipboard', () => {
      let incomingDataProvider: IncomingDataProvider;
      beforeEach(() => {
        const clipboardProvider: ClipboardProvider = testBed.get(
          ClipboardProvider
        );
        incomingDataProvider = testBed.get(IncomingDataProvider);
        spyOn(clipboardProvider, 'getData').and.returnValue(Promise.resolve());
      });
      it('should ignore BitcoinAddress', async () => {
        spyOn(incomingDataProvider, 'parseData').and.returnValue({
          type: 'BitcoinAddress'
        });
        await instance.checkClipboard();
        expect(instance.validDataFromClipboard).toBeNull();
      });
      it('should ignore BitcoinCashAddress', async () => {
        spyOn(incomingDataProvider, 'parseData').and.returnValue({
          type: 'BitcoinCashAddress'
        });
        await instance.checkClipboard();
        expect(instance.validDataFromClipboard).toBeNull();
      });
    });
  });
});
