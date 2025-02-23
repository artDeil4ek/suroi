import Phaser from "phaser";

import core from "../core";
import type { Game } from "../game";
import type { MenuScene } from "./menuScene";
import { Player } from "../objects/player";

import { InputPacket } from "../packets/sending/inputPacket";
import { JoinPacket } from "../packets/sending/joinPacket";

import { localStorageInstance } from "../utils/localStorageHandler";
import type { PlayerManager } from "../utils/playerManager";
import { GAS_ALPHA, GAS_COLOR } from "../utils/constants";

import { ObjectCategory } from "../../../../common/src/constants";
import { Materials } from "../../../../common/src/definitions/obstacles";
import { Guns } from "../../../../common/src/definitions/guns";

import { ObjectType } from "../../../../common/src/utils/objectType";
import { Loot } from "../objects/loot";
import { circleCollision, distanceSquared } from "../../../../common/src/utils/math";
import { requestFullscreen } from "../utils/misc";
import { ItemType } from "../../../../common/src/utils/objectDefinitions";
import { type LootDefinition } from "../../../../common/src/definitions/loots";

export class GameScene extends Phaser.Scene {
    activeGame!: Game;
    sounds: Map<string, Phaser.Sound.BaseSound> = new Map<string, Phaser.Sound.BaseSound>();
    soundsToLoad: Set<string> = new Set<string>();
    volume = localStorageInstance.config.sfxVolume * localStorageInstance.config.masterVolume;
    playerManager!: PlayerManager;

    gasRect!: Phaser.GameObjects.Rectangle;
    gasCircle!: Phaser.GameObjects.Arc;
    gasMask!: Phaser.Display.Masks.GeometryMask;

    tickInterval!: number;

    constructor() {
        super("game");
    }

    // noinspection JSUnusedGlobalSymbols
    preload(): void {
        if (core.game === undefined) return;
        this.activeGame = core.game;
        this.playerManager = core.game.playerManager;

        for (const material of Materials) {
            this.loadSound(`${material}_hit_1`, `hits/${material}_hit_1`);
            this.loadSound(`${material}_hit_2`, `hits/${material}_hit_2`);
            this.loadSound(`${material}_destroyed`, `hits/${material}_destroyed`);
        }

        for (const gun of Guns) {
            this.loadSound(`${gun.idString}_fire`, `weapons/${gun.idString}_fire`);
            this.loadSound(`${gun.idString}_switch`, `weapons/${gun.idString}_switch`);
            this.loadSound(`${gun.idString}_reload`, `weapons/${gun.idString}_reload`);
        }

        const soundsToLoad: string[] = ["pickup", "ammo_pickup", "gun_click", "swing"];
        for (const sound of soundsToLoad) {
            this.loadSound(sound, sound);
        }

        this.loadSound("player_hit_1", "hits/player_hit_1");
        this.loadSound("player_hit_2", "hits/player_hit_2");
        this.loadSound("grass_step_1", "footsteps/grass_1");
        this.loadSound("grass_step_2", "footsteps/grass_2");

        this.scale.on("resize", this.resize.bind(this));

        if (this.playerManager.isMobile) requestFullscreen();
    }

    private resize(): void {
        if (this.cameras.main === undefined) return;
        this.cameras.main.setZoom(window.innerWidth / 2560); // 2560 = 1x, 5120 = 2x
        this.gasRect?.setSize(this.game.canvas.width * 2, this.game.canvas.height * 2).setScale(1 / this.cameras.main.zoom, 1 / this.cameras.main.zoom);
    }

    private loadSound(name: string, path: string): void {
        try {
            this.load.audio(name, require(`../../assets/audio/sfx/${path}.mp3`));
            this.soundsToLoad.add(name);
        } catch (e) {
            console.warn(`Failed to load sound: ${name}`);
            console.error(e);
        }
    }

    get player(): Player {
        return this.activeGame.activePlayer;
    }

    create(): void {
        (this.scene.get("menu") as MenuScene).stopMusic();

        for (const sound of this.soundsToLoad) {
            this.sounds.set(sound, this.sound.add(sound));
        }

        $("#game-ui").show();

        // Draw the grid
        const GRID_WIDTH = 7200;
        const GRID_HEIGHT = 7200;
        const CELL_SIZE = 160;

        for (let x = 0; x <= GRID_WIDTH; x += CELL_SIZE) {
            this.add.line(x, 0, x, 0, x, GRID_HEIGHT * 2, 0x000000, 0.25).setOrigin(0, 0);
        }
        for (let y = 0; y <= GRID_HEIGHT; y += CELL_SIZE) {
            this.add.line(0, y, 0, y, GRID_WIDTH * 2, y, 0x000000, 0.25).setOrigin(0, 0);
        }

        // Create gas rectangle and mask
        this.gasCircle = this.add.circle(7200, 7200, 10240, 0x000000, 0);
        this.gasMask = this.make.graphics().createGeometryMask(this.gasCircle).setInvertAlpha(true);
        this.gasRect = this.add.rectangle(0, 0, this.game.canvas.width * 2, this.game.canvas.height * 2, GAS_COLOR, GAS_ALPHA)
            .setDepth(10).setMask(this.gasMask).setScrollFactor(0, 0).setOrigin(0.25, 0.25);

        // Create the player
        this.activeGame.activePlayer = new Player(this.activeGame, this, ObjectType.categoryOnly(ObjectCategory.Player), -1, true);
        this.playerManager.name = $("#username-input").text();

        // Follow the player w/ the camera
        this.cameras.main.startFollow(this.player.images.container);

        // Send a packet indicating that the game is now active
        this.activeGame.sendPacket(new JoinPacket(this.playerManager));

        // Initializes sounds
        [
            "swing",
            "grass_step_1",
            "grass_step_2"
        ].forEach(item => this.sounds.set(item, this.sound.add(item, { volume: this.volume })));

        this.resize();

        // Start the tick loop
        this.tickInterval = window.setInterval(this.tick.bind(this), 30);

        this.events.on("shutdown", () => {
            window.clearInterval(this.tickInterval);
        });
    }

    playSound(name: string): void {
        const sound: Phaser.Sound.BaseSound | undefined = this.sounds.get(name);
        if (sound === undefined) {
            console.warn(`Unknown sound: "${name}"`);
            return;
        }
        sound.play({ volume: this.volume });
    }

    skipLootCheck = true;

    tick(): void {
        if (!this.activeGame.gameStarted) return;

        if (this.playerManager.dirty.inputs) {
            this.playerManager.dirty.inputs = false;
            this.activeGame.sendPacket(new InputPacket(this.playerManager));
        }

        this.skipLootCheck = !this.skipLootCheck;
        if (this.skipLootCheck) return;

        // Loop through all loot objects to check if the player is colliding with one to show the interact message
        let minDist = Number.MAX_VALUE;
        let closestObject: Loot | undefined;
        const player = this.player;
        for (const o of this.activeGame.objects) {
            const object = o[1];
            if (object instanceof Loot && object.canInteract(this.playerManager)) {
                const dist = distanceSquared(object.position, player.position);
                if (circleCollision(player.position, player.radius, object.position, object.radius) && dist < minDist) {
                    minDist = dist;
                    closestObject = object;
                }
            }
        }

        if (closestObject !== undefined) {
            const prepareInteractText = (): void => {
                if (closestObject === undefined) return;
                let interactText = closestObject.type.definition.name;
                if (closestObject.count > 1) interactText += ` (${closestObject.count})`;
                $("#interact-text").html(interactText);
            };
            if (this.playerManager.isMobile) {
                const lootDef = closestObject.type.definition as LootDefinition;
                if (
                    (lootDef.itemType === ItemType.Ammo || lootDef.itemType === ItemType.Healing) ||
                    (lootDef.itemType === ItemType.Gun && (!this.playerManager.weapons[0] || !this.playerManager.weapons[1])) ||
                    (lootDef.itemType === ItemType.Melee && this.playerManager.weapons[2]?.idString === "fists")
                ) {
                    this.playerManager.interact();
                } else if (lootDef.itemType === ItemType.Gun || lootDef.itemType === ItemType.Melee) {
                    prepareInteractText();
                    $("#interact-key").html('<img src="/img/misc/tap-icon.svg" alt="Tap">');
                    $("#interact-message").show();
                    return;
                }
                $("#interact-message").hide();
            } else {
                prepareInteractText();
                $("#interact-key").text(localStorageInstance.config.keybinds.interact[0]);
                $("#interact-message").show();
            }
        } else {
            $("#interact-message").hide();
        }
    }

    update(): void {
        if (localStorageInstance.config.showFPS) {
            $("#fps-counter").text(`${Math.round(this.game.loop.actualFps)} fps`);
        }
    }
}
