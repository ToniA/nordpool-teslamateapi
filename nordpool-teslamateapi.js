// Charging should be ready by this full hour, like 7:00 (24h, i.e. 7AM)
// Array starting from Sunday. Example: ready by 07:00 on Mon-Fri, 08:00 on Sat-Sun
const chargeReadyHour = [ 8, 7, 7, 7, 7, 7, 8 ]

// How many percentage points of charge the car gains in one hour
const chargePercentagePointsPerHour = 9

// How many percentage points the charge rate drops below 0°C, per each °
const chargePercentagePointsPerHourColdFactor = 0.07

// On which hour to start charging if anything fails
const fallbackChargeStartHour = 23

try {
    // 'Car Dashboards' saves the topics into global context in format [value, timestamp]
    const battery_level = global.get("battery_level")[0]
    const charging_state = global.get("charging_state")[0]
    const charge_limit_soc = global.get("charge_limit_soc")[0]
    const outside_temp = global.get("outside_temp")[0]
    const scheduled_charging_start_time = global.get("scheduled_charging_start_time")[0]

    node.warn(`Battery ${battery_level}%, charge limit: ${charge_limit_soc}%`)
    node.warn(`Charging state: ${charging_state}, outside temperature: ${outside_temp}`)
    node.warn(`Charge scheduled at: ${scheduled_charging_start_time || "-"}`)

    if (scheduled_charging_start_time == "" || charging_state != "Stopped") {
        node.status({ text: `Not plugged in with scheduled charge: ${charging_state || "-"}` })
        return null
    }

    const percentPointsPerHour = chargePercentagePointsPerHour +
        chargePercentagePointsPerHourColdFactor * (outside_temp < 0 ? outside_temp : 0)
    const chargeHours = Math.ceil((charge_limit_soc - battery_level) / percentPointsPerHour)

    let prices = []

    msg.payload.forEach(pricePoint =>
        prices.push(
            {
                date: new Date(pricePoint.DateTime),
                value: pricePoint.PriceNoTax
            }
        )
    )
    const nordpoolPrices = Enumerable.from(prices)

    // Charge window start is the next full hour
    let chargeStartTime = new Date()
    chargeStartTime.setHours(chargeStartTime.getHours() + 1)
    chargeStartTime.setMinutes(0, 0, 0)

    // Charge window end
    let chargeEndTime = new Date()
    if (chargeStartTime.getHours() >= chargeReadyHour[chargeStartTime.getDay()]) {
        chargeEndTime.setDate(chargeEndTime.getDate() + 1)
    }
    chargeEndTime.setHours(chargeReadyHour[chargeEndTime.getDay()], 0, 0, 0)

    const pricesDuringChargeWindow = nordpoolPrices.where(
        i => new Date(i.date).getTime() >= chargeStartTime.getTime()
            && new Date(i.date).getTime() < chargeEndTime.getTime()
    )

    const hoursToConsider = pricesDuringChargeWindow.take(pricesDuringChargeWindow.count() - chargeHours + 1)

    let startHourPrices = []

    hoursToConsider.toArray().forEach(
        (price, index) =>
            startHourPrices.push({ date: price.date, price: pricesDuringChargeWindow.skip(index).take(chargeHours).sum(i => i.value) })
    )

    const cheapestStartHours = Enumerable.from(startHourPrices).orderBy(i => i.price)
    const startTime = new Date(cheapestStartHours.first().date)
    const startHour = new Date(cheapestStartHours.first().date).getHours()
    const startDelay = startTime.getTime() - new Date().getTime() - 60 * 1000
    node.status({ text: `Charge at: ${startHour.toString().padStart(2, '0')}:00 for ${chargeHours} hours` })

    return [
        {
            "delay": startDelay.toString()
        },
        {
            "payload": {
                "time": startHour * 60,
                "enable": "true"
            }
        }
    ]
} catch (e) {
    node.warn(`Exception: ${e}`)
    node.status({ text: `Failure, charge at ${fallbackChargeStartHour}:00` })

    // defaults:
    // * 4 minutes delay -> 22:59 if this executes at 22:55
    // * 23:00 charge start time
    return [
        {
            "delay": (4 * 60 * 1000).toString()
        },
        {
            "payload": {
                "time": fallbackChargeStartHour * 60,
                "enable": "true"
            }
        }
    ]
}