import { BitStream } from "@damienvesper/bit-buffer";

import { type Vector } from "./vector";
import { ObjectType } from "./objectType";

import { type ObjectDefinitions } from "./objectDefinitions";
import { ObjectDefinitionsList } from "./objectDefinitionsList";

import {
    MAX_OBJECT_SCALE,
    MIN_OBJECT_SCALE,
    OBJECT_CATEGORY_BITS,
    type ObjectCategory, PACKET_TYPE_BITS,
    type PacketType,
    VARIATION_BITS,
    PLAYER_NAME_MAX_LENGTH, OBJECT_ID_BITS
} from "../constants";
import { type Variation } from "../typings";
import { normalizeAngle } from "./math";

export class SuroiBitStream extends BitStream {
    constructor(source: ArrayBuffer, byteOffset = 0, byteLength = 0) {
        super(source, byteOffset, byteLength);
    }

    /**
    * Allocs a new Suroi Bit Stream.
    * @param length The size of the stream.
    * @return The Suroi Bit Stream object.
    */
    static alloc(length: number): SuroiBitStream {
        return new SuroiBitStream(new ArrayBuffer(length));
    }

    /**
    * Write a floating point number to the stream.
    * @param value The number.
    * @param min The minimum number.
    * @param max The maximum number.
    * @param bitCount The number of bits to write
    */
    writeFloat(value: number, min: number, max: number, bitCount: number): void {
        const range = (1 << bitCount) - 1;
        const clamped = value < max ? (value > min ? value : min) : max;
        this.writeBits(((clamped - min) / (max - min)) * range + 0.5, bitCount);
    }

    /**
    * Read a floating point number from the stream.
    * @param min The minimum number.
    * @param max The maximum number.
    * @param bitCount The number of bits to read
    * @return The floating point number.
    */
    readFloat(min: number, max: number, bitCount: number): number {
        const range = (1 << bitCount) - 1;
        return min + (max - min) * this.readBits(bitCount) / range;
    }

    /**
    * Write a position Vector to the stream.
    * @param vector The Vector.
    * @param minX The minimum X position.
    * @param minY The minimum Y position.
    * @param maxX The maximum X position.
    * @param maxY The maximum Y position.
    * @param bitCount The number of bits to write.
    */
    writeVector(vector: Vector, minX: number, minY: number, maxX: number, maxY: number, bitCount: number): void {
        this.writeVector2(vector.x, vector.y, minX, minY, maxX, maxY, bitCount);
    }

    /**
    * Write a position Vector to the stream.
    * @param x The X position.
    * @param y The Y position.
    * @param minX The minimum X position.
    * @param minY The minimum Y position.
    * @param maxX The maximum X position.
    * @param maxY The maximum Y position.
    * @param bitCount The number of bits to write.
    * @return The position Vector.
    */
    writeVector2(x: number, y: number, minX: number, minY: number, maxX: number, maxY: number, bitCount: number): void {
        this.writeFloat(x, minX, maxX, bitCount);
        this.writeFloat(y, minY, maxY, bitCount);
    }

    /**
    * Read a position Vector from the stream.
    * @param minX The minimum X position.
    * @param minY The minimum Y position.
    * @param maxX The maximum X position.
    * @param maxY The maximum Y position.
    * @param bitCount The number of bits to read
    */
    readVector(minX: number, minY: number, maxX: number, maxY: number, bitCount: number): Vector {
        return {
            x: this.readFloat(minX, maxX, bitCount),
            y: this.readFloat(minY, maxY, bitCount)
        };
    }

    /**
    * Write a packet type to the stream.
    * @param value The packet type.
    */
    writePacketType(value: PacketType): void {
        this.writeBits(value, PACKET_TYPE_BITS);
    }

    /**
    * Read a packet type from stream.
    * @return The packet type.
    */
    readPacketType(): PacketType {
        return this.readBits(PACKET_TYPE_BITS) as PacketType;
    }

    /**
    * Write a game object type to the stream.
    * @param type The ObjectType
    */
    writeObjectType(type: ObjectType): void {
        this.writeBits(type.category, OBJECT_CATEGORY_BITS);
        this.writeObjectTypeNoCategory(type);
    }

    /**
     * Write a game object type, minus the category, to the stream.
     * @param type The ObjectType
     */
    writeObjectTypeNoCategory(type: ObjectType): void {
        const definitions: ObjectDefinitions | undefined = ObjectDefinitionsList[type.category];
        if (definitions !== undefined) {
            this.writeBits(type.idNumber, definitions.bitCount);
        }
    }

    /**
    * Read a game object type from stream.
    * @return The object type.
    */
    readObjectType(): ObjectType {
        const category: ObjectCategory = this.readBits(OBJECT_CATEGORY_BITS);
        return this.readObjectTypeNoCategory(category);
    }

    /**
     * Read a game object type, minus the category, from stream.
     * @param category The object category
     * @return The object type
     */
    readObjectTypeNoCategory(category: ObjectCategory): ObjectType {
        const definitions: ObjectDefinitions | undefined = ObjectDefinitionsList[category];

        if (definitions !== undefined) {
            const idNumber = this.readBits(definitions.bitCount);
            return ObjectType.fromNumber(category, idNumber);
        } else {
            return ObjectType.categoryOnly(category);
        }
    }

    /**
     * Write an object ID to the stream.
     * @param id The object ID to write
     */
    writeObjectID(id: number): void {
        this.writeBits(id, OBJECT_ID_BITS);
    }

    /**
     * Read an object ID from the stream.
     * @return The object ID
     */
    readObjectID(): number {
        return this.readBits(OBJECT_ID_BITS);
    }

    /**
    * Write a position Vector to the stream with the game default max and minimum X and Y.
    * This is used to write positions from the server to the client.
    * And the Y position is subtracted from 720 because phaser Y axis is inverted.
    * @param vector The Vector to write.
    */
    writePosition(vector: Vector): void {
        this.writePosition2(vector.x, vector.y);
    }

    /**
    * Write a position Vector to the stream with the game default max and minimum X and Y.
    * This is used to write positions from the server to the client.
    * And the Y position is subtracted from 720 because phaser Y axis is inverted.
    * @param x The x-coordinate of the vector to write
    * @param y The y-coordinate of the vector to write
    */
    writePosition2(x: number, y: number): void {
        this.writeVector2(x, 720 - y, 0, 0, 1024, 1024, 16);
    }

    /**
    * Read a position Vector from stream with the game default max and minimum X and Y.
    * @return the position Vector.
    */
    readPosition(): Vector {
        return this.readVector(0, 0, 1024, 1024, 16);
    }

    /**
     * Write a rotation to the stream.
     * @param value The rotation to write, in radians
     * @param bitCount The number of bits to write
     */
    writeRotation(value: number, bitCount: number): void {
        this.writeFloat(value, -Math.PI, Math.PI, bitCount);
    }

    /**
     * Read a rotation from the stream.
     * @param bitCount The number of bits to read
     * @return The rotation in radians.
     */
    readRotation(bitCount: number): number {
        return this.readFloat(-Math.PI, Math.PI, bitCount);
    }

    /**
     * Write an obstacle rotation to the stream.
     * @param value The rotation to write, in radians
     * @param mode The rotation mode (full, limited, binary, or none)
     */
    writeObstacleRotation(value: number, mode: string): void {
        switch (mode) {
            case "full":
                this.writeRotation(value, 4);
                break;
            case "limited": // 4 possible orientations
                this.writeBits(value, 2);
                break;
            case "binary": // 2 possible orientations
                this.writeBits(value, 1);
                break;
        }
    }

    /**
     * Read an obstacle rotation from the stream.
     * @param mode The rotation mode (full, limited, binary, or none)
     * @return The rotation in radians.
     */
    readObstacleRotation(mode: string): number {
        switch (mode) {
            case "full":
                return this.readRotation(4);
            case "limited": // 4 possible orientations
                return normalizeAngle(this.readBits(2) * (Math.PI / 2));
            case "binary": // 2 possible orientations
                if (this.readBoolean()) return Math.PI / 2;
                else return 0;
        }
        return 0;
    }

    /**
    * Write a game object scale to the stream.
    * @param value The scale to write.
    */
    writeScale(value: number): void {
        this.writeFloat(value, MIN_OBJECT_SCALE, MAX_OBJECT_SCALE, 8);
    }

    /**
    * Read a game object scale from the stream.
    * @return The object scale.
    */
    readScale(): number {
        return this.readFloat(MIN_OBJECT_SCALE, MAX_OBJECT_SCALE, 8);
    }

    /**
    * Write a game object variation to the stream.
    * @param value The variation value to write.
    */
    writeVariation(value: Variation): void {
        this.writeBits(value, VARIATION_BITS);
    }

    /**
    * Read a game object variation from the stream.
    * @return The object variation.
    */
    readVariation(): Variation {
        return this.readBits(VARIATION_BITS) as Variation;
    }

    /**
    * Write a player name to the stream
    * @param name The player name.
    */
    writePlayerName(name: string): void {
        this.writeUTF8String(name, PLAYER_NAME_MAX_LENGTH);
    }

    /**
    * Read a player name from the stream
    * @return The player name.
    */
    readPlayerName(): string {
        return this.readUTF8String(PLAYER_NAME_MAX_LENGTH);
    }

    /**
    * Write a player name with dev colors to the stream
    * @return The player name.
    */
    writePlayerNameWithColor(name: string, isDev: boolean, color: string): void {
        this.writePlayerName(name);
        this.writeBoolean(isDev);
        if (isDev) {
            this.writeUTF8String(color, 10);
        }
    }

    /**
    * Read a player name with dev colors from the stream
    * @return The player name on a span element with the color if its a dev.
    */
    readPlayerNameWithColor(): string {
        const playerName = this.readPlayerName();
        const isDev = this.readBoolean();
        const style = isDev ? `style="color: ${this.readUTF8String(10)}"` : "";
        return `<span ${style}>${playerName}</span>`;
    }
}
