const Web3 = require('web3');
const BigNumber = require('bignumber.js');
const fs = require('fs');
// eslint-disable-next-line prefer-destructuring
const execSync = require('child_process').execSync;
const connectionConfig = require('../../truffle');
const utils = require('../../scripts_utils/utils');

const networkProvider = process.argv[2];
const jurisdictionContractAddress = process.argv[3];
const addressesCSV = process.argv[4];
let networkInUse;
let addressInUse;
let cmd;
let web3;
const nonces = {};
// eslint-disable-next-line no-undef
const allocateTo = typeof (allocationType) === 'undefined' ? 'foundation' : global.allocationType;

// validate network
if (typeof (networkProvider) === 'undefined') {
  console.warn('Must supply networkProvider');
  process.exit(0);
} else { // default provider
  networkInUse = `${networkProvider}0`;
  web3 = connectionConfig.networks[networkInUse].provider;
}

// validate jurisdiction contract address
if (typeof (jurisdictionContractAddress) === 'undefined') {
  console.warn('Must supply jurisdictionContractAddress');
  process.exit(0);
}

// validate csv file passed
if (typeof (addressesCSV) === 'undefined') {
  console.warn('Must supply path to CSV');
  process.exit(0);
}
const timestamp = Math.round((new Date()).getTime() / 1000);
const allocationMetadataFilename = `output/allocation-${allocateTo}-${networkProvider}.json`;
let allocationsData;
try {
  // eslint-disable-next-line import/no-dynamic-require,global-require
  allocationsData = require(`../../${allocationMetadataFilename}`);
} catch (error) {
  allocationsData = {};
}
allocationsData.allocations = [];
const zosData = JSON.parse(fs.readFileSync(`zos.${networkProvider}.json`, 'utf8'));
const PropsTokenContractAddress = zosData.proxies['PropsToken/PropsToken'][0].address;
const propsContractABI = require('../../build/contracts/PropsToken.json');
const jurisdictionContractABI = require('../../build/contracts/BasicJurisdiction.json');

async function main() {
  // instantiate propstoken
  networkInUse = `${networkProvider}2`;
  const tokenHolderAddress = connectionConfig.networks[networkInUse].wallet_address;
  const providerTransferrer = connectionConfig.networks[networkInUse].provider();
  web3 = new Web3(providerTransferrer);
  const propsContractInstance = new web3.eth.Contract(propsContractABI.abi, PropsTokenContractAddress);
  nonces[tokenHolderAddress] = await web3.eth.getTransactionCount(tokenHolderAddress);

  // instantiate jurisdiction
  networkInUse = `${networkProvider}Validator`;
  const validatorAddress = connectionConfig.networks[networkInUse].wallet_address;
  const providerValidator = connectionConfig.networks[networkInUse].provider();
  web3 = new Web3(providerValidator);
  const jurisdictionContractInstance = new web3.eth.Contract(jurisdictionContractABI.abi, jurisdictionContractAddress);
  nonces[validatorAddress] = await web3.eth.getTransactionCount(validatorAddress);

  // read csv
  const allocationContents = fs.readFileSync(addressesCSV, 'utf8');
  const allocationArray = allocationContents.split(/\r?\n/);
  for (let i = 1; i < allocationArray.length; i += 1) {
    console.log(`Working on row:${allocationArray[i]}`);
    const allocationData = allocationArray[i].split(',');
    // Address,Tokens,Vesting Duration,Vesting Cliff,Percentage Vested
    const address = allocationData[0];
    const tokensRead = new BigNumber(allocationData[1]);
    // const _tokensMultiplier = new BigNumber(1 * 10 ** 18);
    const tokens = tokensRead; // .multipliedBy(_tokensMultiplier);
    const duration = new BigNumber(allocationData[2]);
    const cliff = new BigNumber(allocationData[3]);
    const percent = new BigNumber(allocationData[4]);
    // deploy proxy contract per address
    networkInUse = `${networkProvider}1`;
    addressInUse = connectionConfig.networks[networkInUse].wallet_address;

    const start = (timestamp) + utils.duration.minutes(1);
    const cliffDuration = utils.duration.days(cliff);
    const vestingDuration = utils.duration.days(duration);
    const recovable = 'false';
    const beneficiary = address;

    const tokensToVest = tokens.multipliedBy(percent).dividedBy(100);
    const tokensToGrant = tokens.minus(tokensToVest);

    const allocationOutput = {};
    allocationOutput.beneficiary = beneficiary;
    allocationOutput.start = start;
    allocationOutput.tokensToVest = tokensToVest;
    allocationOutput.tokensToGrant = tokensToGrant;
    allocationOutput.vestingDuration = duration;
    allocationOutput.cliffDuration = cliff;

    if (tokensToVest > 0) {
      cmd = `zos create TokenVesting -v --init initialize \
      --args ${beneficiary},${start},${cliffDuration},${vestingDuration},${recovable},${addressInUse} \
      --network ${networkInUse} --from ${addressInUse}`;
      try {
        // create token vesting contract
        console.log(`Executing ${cmd}`);
        const tokenVestingProxyContractAddress = execSync(cmd).toString().replace(/\n$/, '');
        allocationOutput.vestingContractAddress = tokenVestingProxyContractAddress;

        // whitelist the vesting contract
        console.log(`Issuing attribute for vesting contract ${tokenVestingProxyContractAddress}`);
        // eslint-disable-next-line no-await-in-loop
        await jurisdictionContractInstance.methods.issueAttribute(
          tokenVestingProxyContractAddress,
          1,
          0,
        ).send({
          from: validatorAddress,
          gas: utils.gasLimit('attribute'),
          gasPrice: utils.gasPrice(),
          nonce: utils.getAndIncrementNonce(nonces, validatorAddress),
        }).then((receipt) => {
          allocationOutput.validatedVestingContract = true;
          allocationOutput.validationVestingTx = receipt.transactionHash;
          console.log(`Attribute set for vesting contract ${tokenVestingProxyContractAddress}`);
        }).catch((error) => {
          console.warn(`Error setting attribute for vesting contract ${tokenVestingProxyContractAddress}:${error}`);
        });
        // transfer to vesting contract
        console.log(`Transferring ${tokensToVest.toString()} to vesting contract from ${tokenHolderAddress}`);
        // eslint-disable-next-line no-await-in-loop
        await propsContractInstance.methods.transfer(
          tokenVestingProxyContractAddress,
          web3.utils.toWei(tokensToVest.toString()),
        ).send({
          from: tokenHolderAddress,
          gas: utils.gasLimit('transfer'),
          gasPrice: utils.gasPrice(),
          nonce: utils.getAndIncrementNonce(nonces, tokenHolderAddress),
        }).then((receipt) => {
          allocationOutput.vestingTransferTx = receipt.transactionHash;
          console.log(`Transferred ${tokensToVest.toString()} to vesting contract from ${tokenHolderAddress} (tx=${receipt.transactionHash})`);
        }).catch((error) => {
          console.warn(`Error transferring ${tokensToVest.toString()} to vesting contract from ${tokenHolderAddress}:${error}`);
        });
      } catch (err) {
        console.warn(err);
      }
    }

    // whitelist beneficianry
    console.log(`Issuing attribute for beneficiary ${beneficiary}`);

    // check if not validated already
    let isBeneficiaryValidated = false;
    // eslint-disable-next-line no-await-in-loop
    await jurisdictionContractInstance.methods.hasAttribute(beneficiary, 1)
      .call()
      .then((val) => {
        isBeneficiaryValidated = val;
      });
    if (!isBeneficiaryValidated) {
      // eslint-disable-next-line no-await-in-loop
      await jurisdictionContractInstance.methods.issueAttribute(
        beneficiary,
        1,
        0,
      ).send({
        from: validatorAddress,
        gas: utils.gasLimit('attribute'),
        gasPrice: utils.gasPrice(),
        nonce: utils.getAndIncrementNonce(nonces, validatorAddress),
      }).then((receipt) => {
        allocationOutput.validatedBeneficiary = true;
        allocationOutput.validatedBeneficiaryTx = receipt.transactionHash;
        console.log(`Attribute set for beneficiary ${beneficiary}`);
      }).catch((error) => {
        console.warn(`Error setting attribute for beneficiary ${beneficiary}:${error}`);
      });
    }
    if (tokensToGrant > 0) {
      try {
        // transfer to beneficiary
        console.log(`Transferring ${tokensToGrant.toString()} to beneficiary ${beneficiary} from ${tokenHolderAddress}`);
        // eslint-disable-next-line no-await-in-loop
        await propsContractInstance.methods.transfer(
          beneficiary,
          web3.utils.toWei(tokensToGrant.toString()),
        ).send({
          from: tokenHolderAddress,
          gas: utils.gasLimit('transfer'),
          gasPrice: utils.gasPrice(),
          nonce: utils.getAndIncrementNonce(nonces, tokenHolderAddress),
        }).then((receipt) => {
          allocationOutput.beneficiaryTransferTx = receipt.transactionHash;
          console.log(`Transferred ${tokensToGrant.toString()} to beneficiary ${beneficiary} from ${tokenHolderAddress} (tx=${receipt.transactionHash})`);
        }).catch((error) => {
          console.warn(`Error transferring ${tokensToGrant.toString()} to beneficiary ${beneficiary} from ${tokenHolderAddress}:${error}`);
        });
      } catch (err) {
        console.warn(err);
      }
    }
    console.log(`Pushing into allocationData.allocations ${JSON.stringify(allocationOutput)}`);
    allocationsData.allocations.push(allocationOutput);
  }

  fs.writeFile(
    allocationMetadataFilename,
    JSON.stringify(allocationsData),
    { flag: 'w' },
    (err) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      console.log(`metadata written to ${allocationMetadataFilename}`);
      console.log(JSON.stringify(allocationsData, null, 2));
      process.exit(0);
    },
  );
}

try {
  main();
} catch (err) {
  console.warn(err);
}