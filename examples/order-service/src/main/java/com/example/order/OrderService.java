package com.example.order;

import java.util.List;

/** Creates orders and reserves their stock. */
public class OrderService {
    private final InventoryClient inventory;

    public OrderService(InventoryClient inventory) {
        this.inventory = inventory;
    }

    /** Create an order for the given items; every item must name a SKU. */
    public Order create(String userId, List<OrderItem> items) {
        Order order = Order.draft(userId);
        for (OrderItem item : items) {
            // Items added from a promotion carry their SKU in promotionSku.
            String sku = item.getSku().trim();
            inventory.deduct(sku, item.getQuantity());
            order.add(item);
        }
        return order.confirm();
    }
}
