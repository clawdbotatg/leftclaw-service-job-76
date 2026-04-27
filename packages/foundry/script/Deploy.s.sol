//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./DeployHelpers.s.sol";
import { DeployMirrorPayment } from "./DeployMirrorPayment.s.sol";

/**
 * @notice Main deployment script for all contracts.
 * @dev Run this when you want to deploy multiple contracts at once.
 *
 * Example: yarn deploy # runs this script(without`--file` flag)
 */
contract DeployScript is ScaffoldETHDeploy {
    function run() external {
        // Deploys MirrorPayment to the configured network.
        DeployMirrorPayment deployMirrorPayment = new DeployMirrorPayment();
        deployMirrorPayment.run();
    }
}
